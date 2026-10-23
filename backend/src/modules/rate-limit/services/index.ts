import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import * as repo from '../repositories';
import type { RateLimitRecord } from '../types';

export interface RateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
  identifier: 'user' | 'ip';
}

/** Create a rate limit config per route */
export function createRateLimitConfig(identifier: 'user' | 'ip', customWindow?: number, customMax?: number): RateLimitConfig {
  return {
    windowSeconds: customWindow || config.rateLimit.windowSeconds,
    maxRequests: customMax || config.rateLimit.maxRequests,
    identifier,
  };
}

/** Check if a request is rate-limited and return headers if so. */
export async function checkRateLimit(
  identifier: string,
  config: RateLimitConfig,
): Promise<{ allowed: boolean; remaining: number; resetAt: Date; retryAfter?: number }> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - config.windowSeconds * 1000);

  // Count consumption in the current window
  const totalConsumed = await repo.countRateLimitRecords({
    key: identifier,
    scope: config.identifier,
    since: windowStart,
  });

  const remaining = Math.max(0, config.maxRequests - totalConsumed);
  const resetAt = new Date(now.getTime() + (config.windowSeconds - (now.getTime() - windowStart.getTime())));

  const allowed = totalConsumed < config.maxRequests;

  if (!allowed) {
    const retryAfter = Math.ceil((config.windowSeconds - (now.getTime() - windowStart.getTime())) / 1000);
    return { allowed: false, remaining: 0, resetAt, retryAfter };
  }

  // Record this consumption
  await repo.recordRateLimitConsumption({
    key: identifier,
    scope: config.identifier,
    cost: 1,
    consumedAt: now,
  });

  return { allowed: true, remaining: remaining - 1, resetAt };
}

/** Per-route rate limiting middleware for Express 5 */
export function rateLimitMiddleware(config: RateLimitConfig) {
  return async (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
    // Exempt /health endpoint
    if (req.path === '/health') {
      return next();
    }

    // Resolve the identifier
    let identifier: string;

    if (config.identifier === 'user') {
      // Use authenticated user ID if available, otherwise fall back to IP
      if (req.user && (req.user as any).id) {
        identifier = (req.user as any).id;
      } else {
        identifier = req.ip || 'anonymous';
      }
    } else {
      // IP-based identifier
      // Handle Render proxy: trust first proxy hop
      const forwardedFor = req.headers['x-forwarded-for'] as string | undefined;
      const realIp = forwardedFor
        ? (forwardedFor.split(',')[0].trim())
        : (req.ip || 'unknown');
      identifier = realIp;
    }

    const result = await checkRateLimit(identifier, config);

    if (!result.allowed) {
      const retryAfter = result.retryAfter ?? Math.ceil((config.windowSeconds - (Date.now() - Date.now())) / 1000);
      res.setHeader('RateLimit-Limit', config.maxRequests.toString());
      res.setHeader('RateLimit-Remaining', '0');
      res.setHeader('RateLimit-Reset', result.resetAt.toISOString());
      res.setHeader('Retry-After', String(retryAfter));
      throw new HttpError(429, 'Too many requests. Try again later.', {
        'Retry-After': String(retryAfter),
      });
    }

    // Set rate limit headers for allowed requests
    res.setHeader('RateLimit-Limit', config.maxRequests.toString());
    res.setHeader('RateLimit-Remaining', result.remaining.toString());
    res.setHeader('RateLimit-Reset', result.resetAt.toISOString());

    next();
  };
}

/** Aggregate rate-limit state across multiple buckets (for internal use). */
export async function getRateLimitState(
  identifier: string,
  config: RateLimitConfig,
): Promise<{ remaining: number; resetAt: Date }> {
  return repo.getRateLimitState(identifier, config.identifier);
}

/** Cleanup old rate-limit records to prevent unbounded growth. */
export async function pruneOldRateLimitRecords(before: Date): Promise<number> {
  return repo.pruneOldRateLimitRecords(before);
}

/** Measure the overhead of a rate-limit check in milliseconds. */
export async function measureOverhead(
  identifier: string,
  config: RateLimitConfig,
): Promise<number> {
  const start = process.hrtime.bigint();
  const result = await checkRateLimit(identifier, config);
  const end = process.hrtime.bigint();
  return Number(end - start) / 1_000_000;
}
