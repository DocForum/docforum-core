import { prisma } from "../db/prisma-client";

export async function expireUnfulfilledOrders(now = new Date()): Promise<number> {
  const result = await prisma.labOrder.updateMany({ where: { status: "issued", expiresAt: { not: null, lte: now } }, data: { status: "expired" } });
  return result.count;
}
