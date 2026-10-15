// Login brute-force protection (Phase 8, issue #35).
//
// The policy lives here as pure functions over plain bucket structs so it
// can be unit-tested without a database, and the state lives in Postgres
// (repositories/recordFailedLoginAttempt) so it survives restarts and
// doesn't assume the backend is a single process forever.
//
// Two independent buckets are tracked for every login attempt: the
// normalised email address and the client IP. A request is refused if
// *either* is in backoff or locked.
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import * as repo from '../repositories';

export interface ThrottleBucket {
  scope: string;
  key: string;
  failedCount: number;
  lastFailedAt: Date;
  lockUntil: Date | null;
}

export interface ThrottlePolicy {
  windowSeconds: number;
  backoffAfterFailures: number;
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
  lockAfterFailures: number;
  lockSeconds: number;
}

export interface ThrottleDecision {
  blocked: boolean;
  retryAfterSeconds: number;
  reason: 'locked' | 'backoff' | null;
}

export function throttlePolicy(): ThrottlePolicy {
  return {
    windowSeconds: config.loginThrottle.windowSeconds,
    backoffAfterFailures: config.loginThrottle.backoffAfterFailures,
    backoffBaseSeconds: config.loginThrottle.backoffBaseSeconds,
    backoffMaxSeconds: config.loginThrottle.backoffMaxSeconds,
    lockAfterFailures: config.loginThrottle.lockAfterFailures,
    lockSeconds: config.loginThrottle.lockSeconds,
  };
}

/** Exponential backoff, in seconds, for a bucket that has failed
 * `failedCount` times: 0 while below the threshold, then base·2^n capped at
 * the configured maximum. */
export function backoffDelaySeconds(failedCount: number, policy: ThrottlePolicy): number {
  if (failedCount < policy.backoffAfterFailures) return 0;
  const steps = failedCount - policy.backoffAfterFailures;
  return Math.min(policy.backoffBaseSeconds * 2 ** steps, policy.backoffMaxSeconds);
}

/** Decision for a single bucket at `now`: an explicit lock wins, otherwise
 * an unfinished exponential-backoff wait. */
export function evaluateBucket(bucket: ThrottleBucket, now: Date, policy: ThrottlePolicy): ThrottleDecision {
  if (bucket.lockUntil && bucket.lockUntil.getTime() > now.getTime()) {
    return {
      blocked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.lockUntil.getTime() - now.getTime()) / 1000)),
      reason: 'locked',
    };
  }

  const delaySeconds = backoffDelaySeconds(bucket.failedCount, policy);
  if (delaySeconds > 0) {
    const remainingMs = delaySeconds * 1000 - (now.getTime() - bucket.lastFailedAt.getTime());
    if (remainingMs > 0) {
      return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)), reason: 'backoff' };
    }
  }

  return { blocked: false, retryAfterSeconds: 0, reason: null };
}

/** The strictest decision across all buckets for one attempt. */
export function evaluateBuckets(buckets: ThrottleBucket[], now: Date, policy: ThrottlePolicy): ThrottleDecision {
  let worst: ThrottleDecision = { blocked: false, retryAfterSeconds: 0, reason: null };
  for (const bucket of buckets) {
    const decision = evaluateBucket(bucket, now, policy);
    if (!decision.blocked) continue;
    // Report the longest wait; on a tie a lock wins over backoff because it
    // is the harder state and its Retry-After is already an exact deadline.
    const worse =
      !worst.blocked ||
      decision.retryAfterSeconds > worst.retryAfterSeconds ||
      (decision.reason === 'locked' && worst.reason !== 'locked');
    if (worse) worst = decision;
  }
  return worst;
}

/** Throttle bucket key for an account: trimmed + lowercased, so
 * `Doc@Example.com` and `doc@example.com` share one budget. Note this is
 * *only* the throttle key — the account lookup itself stays exactly as it
 * was, so no existing account's stored address changes meaning. */
export function emailThrottleKey(rawEmail: string): string {
  return rawEmail.trim().toLowerCase();
}

/** Express reports IPv4 clients as `::ffff:1.2.3.4` on an IPv6-mapped
 * socket; collapse that so one client can't hold two buckets. */
export function normalizeClientIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped ? mapped[1]!.toLowerCase() : trimmed.toLowerCase();
}

export interface ThrottleKeys {
  emailKey: string;
  ipKey: string | null;
}

/**
 * 429 raised for a throttled login attempt. Carries `retryAfterSeconds` so
 * the login controller can set a real `Retry-After` header (issue #35's
 * DoD). The message is identical for an existing and a non-existent
 * account, and for a lock and a backoff wait, so it can't be used to probe
 * for registered addresses.
 */
export class LoginThrottledError extends HttpError {
  constructor(public readonly retryAfterSeconds: number) {
    super(429, `Too many failed login attempts. Try again in ${retryAfterSeconds}s.`);
  }
}

/** Check before credential verification, so a locked account is refused
 * without the password hash ever being compared. */
export async function checkLoginThrottle(keys: ThrottleKeys): Promise<ThrottleDecision> {
  const buckets = await repo.findThrottleBuckets(keys.emailKey, keys.ipKey);
  return evaluateBuckets(buckets, new Date(), throttlePolicy());
}

/** Record a failed attempt and return the decision *after* it — the caller
 * may be locked out by this very attempt. */
export async function registerFailedLogin(keys: ThrottleKeys): Promise<ThrottleDecision> {
  const policy = throttlePolicy();
  const rows = await Promise.all([
    repo.recordFailedLoginAttempt({ scope: 'email', key: keys.emailKey, policy }),
    keys.ipKey ? repo.recordFailedLoginAttempt({ scope: 'ip', key: keys.ipKey, policy }) : Promise.resolve(null),
  ]);
  return evaluateBuckets(
    rows.filter((row): row is ThrottleBucket => row !== null),
    new Date(),
    policy,
  );
}

/** A successful login clears the per-account counter (issue #35) but
 * deliberately leaves the IP bucket alone — one valid login shouldn't
 * rescan a whole shared-IP budget. */
export async function resetLoginThrottle(emailKey: string): Promise<void> {
  await repo.clearLoginAttempts([{ scope: 'email', key: emailKey }]);
}

/** Admin escape hatch: clear a lock that a legitimate user is stuck behind. */
export async function clearLoginAttempts(input: { email?: string; ip?: string }): Promise<number> {
  const buckets: { scope: string; key: string }[] = [];
  if (input.email) buckets.push({ scope: 'email', key: emailThrottleKey(input.email) });
  if (input.ip) {
    const ip = normalizeClientIp(input.ip);
    if (ip) buckets.push({ scope: 'ip', key: ip });
  }
  return repo.clearLoginAttempts(buckets);
}

/** Cleanup job body (run on an interval from src/server.ts): rows whose last
 * failure is older than the prune threshold are dead weight. */
export async function pruneLoginAttempts(): Promise<number> {
  const before = new Date(Date.now() - config.loginThrottle.pruneAfterSeconds * 1000);
  return repo.pruneStaleLoginAttempts(before);
}
