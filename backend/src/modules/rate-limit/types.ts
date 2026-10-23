import type { Prisma } from '@prisma/client';

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

/** Prisma-based implementation for production. */
export async function prismaRateLimitStore(
  prisma: Prisma.Client,
): Promise<RateLimitStore> {
  return {
    recordConsumption: async (data) => {
      // Production uses raw SQL via prisma.$executeRaw for UPSERT
      await prisma.$executeRaw`
        INSERT INTO "RateLimitRecord" ("key", "scope", "cost", "consumedAt", "createdAt", "updatedAt")
        VALUES (${data.key}, ${data.scope}, ${data.cost}, ${data.consumedAt}, NOW(), NOW())
        ON CONFLICT ("key", "scope") DO UPDATE
        SET "consumedAt" = NOW(),
            "updatedAt" = NOW(),
            "cost" = "RateLimitRecord"."cost" + ${data.cost}
      `;
    },
    countRecords: async (params) => {
      return prisma.$countRateLimitRecord({
        where: {
          key: params.key,
          scope: params.scope,
          consumedAt: {
            gte: params.since,
          },
        },
      });
    },
    getState: async (params) => {
      return prisma.$countRateLimitRecord({
        where: {
          key: params.key,
          scope: params.scope,
          consumedAt: {
            gte: new Date(Date.now() - 60 * 1000),
          },
        },
      }).then((count) => {
        const remaining = Math.max(0, 100 - count);
        const resetAt = new Date(Date.now() + (60 - 60) * 1000);
        return { remaining, resetAt };
      });
    },
    prune: async (oldBefore) => {
      const result = await prisma.$executeRaw`
        DELETE FROM "RateLimitRecord"
        WHERE "consumedAt" < ${oldBefore};
      `;
      return Number(result);
    },
  };
}