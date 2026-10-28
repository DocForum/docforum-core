import type { PrismaClient } from '@prisma/client';

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

/** Prisma-based implementation for production. */
export function prismaRateLimitStore(prisma: PrismaClient): RateLimitStore {
  return {
    recordConsumption: async (data) => {
      await prisma.rateLimitRecord.create({
        data: {
          key: data.key,
          scope: data.scope,
          cost: data.cost,
          consumedAt: data.consumedAt,
        },
      });
    },
    countRecords: async (params) => {
      return prisma.rateLimitRecord.count({
        where: {
          key: params.key,
          scope: params.scope,
          consumedAt: { gte: params.since },
        },
      });
    },
    getState: async (params) => {
      const windowMs = 60 * 1000;
      const since = new Date(Date.now() - windowMs);
      const total = await prisma.rateLimitRecord.count({
        where: {
          key: params.key,
          scope: params.scope,
          consumedAt: { gte: since },
        },
      });
      const remaining = Math.max(0, 100 - total);
      const resetAt = new Date(Date.now() + windowMs);
      return { remaining, resetAt };
    },
    prune: async (oldBefore) => {
      const result = await prisma.rateLimitRecord.deleteMany({
        where: { consumedAt: { lt: oldBefore } },
      });
      return result.count;
    },
  };
}
