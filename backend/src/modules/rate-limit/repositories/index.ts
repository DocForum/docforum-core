import { prisma } from '../../../db/prisma-client';
import type { RateLimitStore } from '../../rate-limit/types';

export interface RateLimitRecord {
  id: string;
  key: string;
  scope: 'user' | 'ip';
  cost: number;
  consumedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Record a rate limit consumption and return the updated bucket state. */
export async function recordRateLimitConsumption(
  key: string,
  scope: 'user' | 'ip',
  cost = 1,
): Promise<{ remaining: number; resetAt: Date }> {
  const now = new Date();
  const windowSeconds = 60; // 1-minute window for rate limiting

  // Use a conditional upsert to atomically increment the counter
  const record = await prisma.$executeRaw`
    INSERT INTO "RateLimitRecord" ("key", "scope", "cost", "consumedAt", "createdAt", "updatedAt")
    VALUES (${key}, ${scope}, ${cost}, ${now}, NOW(), NOW())
    ON CONFLICT ("key", "scope") DO UPDATE
    SET "consumedAt" = NOW(),
        "updatedAt" = NOW(),
        "cost" = "RateLimitRecord"."cost" + ${cost}
    RETURNING "cost";
  `;

  // Count total consumption in the current window
  const totalConsumed = await prisma.$countRateLimitRecord({
    where: {
      key,
      scope,
      consumedAt: {
        gte: new Date(Date.now() - windowSeconds * 1000),
      },
    },
  });

  const remaining = Math.max(0, 100 - totalConsumed); // 100 requests per window
  const resetAt = new Date(Date.now() + (60 - windowSeconds) * 1000);

  return { remaining, resetAt };
}

/** Get rate limit state for a key. */
export async function getRateLimitState(
  key: string,
  scope: 'user' | 'ip',
): Promise<{ remaining: number; resetAt: Date }> {
  const windowSeconds = 60;

  const totalConsumed = await prisma.$countRateLimitRecord({
    where: {
      key,
      scope,
      consumedAt: {
        gte: new Date(Date.now() - windowSeconds * 1000),
      },
    },
  });

  const remaining = Math.max(0, 100 - totalConsumed);
  const resetAt = new Date(Date.now() + (60 - windowSeconds) * 1000);

  return { remaining, resetAt };
}

/** Prune old rate limit records to prevent unbounded growth. */
export async function pruneOldRateLimitRecords(before: Date): Promise<number> {
  const result = await prisma.$executeRaw`
    DELETE FROM "RateLimitRecord"
    WHERE "consumedAt" < ${before};
  `;
  return Number(result);
}