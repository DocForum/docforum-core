import { prisma } from '../../../db/prisma-client';

export async function countRateLimitRecords(params: {
  key: string;
  scope: 'user' | 'ip';
  since: Date;
}): Promise<number> {
  return prisma.rateLimitRecord.count({
    where: {
      key: params.key,
      scope: params.scope,
      consumedAt: { gte: params.since },
    },
  });
}

export async function recordRateLimitConsumption(params: {
  key: string;
  scope: 'user' | 'ip';
  cost: number;
  consumedAt: Date;
}): Promise<void> {
  await prisma.rateLimitRecord.create({
    data: {
      key: params.key,
      scope: params.scope,
      cost: params.cost,
      consumedAt: params.consumedAt,
    },
  });
}

export async function getRateLimitState(
  key: string,
  scope: 'user' | 'ip',
): Promise<{ remaining: number; resetAt: Date }> {
  const windowMs = 60 * 1000;
  const since = new Date(Date.now() - windowMs);
  const total = await prisma.rateLimitRecord.count({
    where: {
      key,
      scope,
      consumedAt: { gte: since },
    },
  });
  const remaining = Math.max(0, 100 - total);
  const resetAt = new Date(Date.now() + windowMs);
  return { remaining, resetAt };
}

export async function pruneOldRateLimitRecords(before: Date): Promise<number> {
  const result = await prisma.rateLimitRecord.deleteMany({
    where: { consumedAt: { lt: before } },
  });
  return result.count;
}
