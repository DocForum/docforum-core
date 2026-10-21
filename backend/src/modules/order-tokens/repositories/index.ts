// order-tokens repositories — data access only. Other modules must not import
// from here directly; go through services/.
import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export async function findOrderTokenByToken(token: string, db: DbClient = prisma) {
  return db.orderToken.findUnique({ where: { token } });
}

export async function findOrderTokenByOrder(orderType: string, orderId: string, db: DbClient = prisma) {
  return db.orderToken.findFirst({
    where: { orderType, orderId },
    orderBy: { version: 'desc' },
  });
}

export async function createOrderToken(db: DbClient, input: {
  orderType: string;
  orderId: string;
  token: string;
  version: number;
  expiresAt?: Date;
}) {
  return db.orderToken.create({ data: input });
}

export async function incrementOrderTokenVersion(db: DbClient, orderType: string, orderId: string) {
  // Find the latest token and create a new one with incremented version
  const latest = await db.orderToken.findFirst({
    where: { orderType, orderId },
    orderBy: { version: 'desc' },
  });
  if (!latest) return null;

  const newVersion = latest.version + 1;
  // Generate new token (done in service)
  return { latest, newVersion };
}