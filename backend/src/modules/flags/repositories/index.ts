import type { Prisma, Role } from '@prisma/client';
import { prisma } from '../../../db/prisma-client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export interface FlagWrite {
  description: string;
  enabled: boolean;
  rolloutPercent: number;
  allowRoles: Role[];
  allowUserIds: string[];
}

export function listFlags(db: DbClient = prisma) {
  return db.featureFlag.findMany({ orderBy: { key: 'asc' } });
}

export function findFlag(db: DbClient, key: string) {
  return db.featureFlag.findUnique({ where: { key } });
}

export function upsertFlag(db: DbClient, key: string, data: FlagWrite) {
  return db.featureFlag.upsert({ where: { key }, create: { key, ...data }, update: data });
}
