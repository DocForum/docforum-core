import type { PrismaClient } from '@prisma/client';
import { MemoryRateLimitStore } from './stores/memory';

/** Store interface for rate-limit state. */
export interface RateLimitStore {
  recordConsumption(data: {
    key: string;
    scope: 'user' | 'ip';
    cost: number;
    consumedAt: Date;
  }): Promise<void>;
  countRecords(params: {
    key: string;
    scope: 'user' | 'ip';
    since: Date;
  }): Promise<number>;
  getState(params: {
    key: string;
    scope: 'user' | 'ip';
  }): Promise<{ remaining: number; resetAt: Date }>;
  prune(oldBefore: Date): Promise<number>;
}

export interface RateLimitRecord {
  id: string;
  key: string;
  scope: 'user' | 'ip';
  cost: number;
  consumedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Production store compatibility wrapper.
 * The repo does not currently define a Prisma model for rate-limit rows, so
 * we deliberately fall back to the in-memory store that is already used by the
 * unit tests instead of calling a nonexistent Prisma helper.
 */
export async function prismaRateLimitStore(_prisma: PrismaClient): Promise<RateLimitStore> {
  return new MemoryRateLimitStore();
}
