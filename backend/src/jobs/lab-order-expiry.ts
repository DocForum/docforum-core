// Lab-order expiry (Phase 4, issue #12) — with the refund trigger of
// issue #84.
//
// A lab order that was never fulfilled by its `expiresAt` moves
// `issued -> expired` through ONE conditional UPDATE, and the
// `order.expired` outbox event is inserted in the SAME transaction. The
// payments worker therefore refunds exactly the orders whose expiry
// committed — a crashed job, a concurrent fulfilment, or a second process
// cannot refund an order that never expired, and cannot expire a fulfilled
// one (the `status: 'issued'` predicate is the guard).
//
// Prescriptions have no `expiresAt` column (ARCHITECTURE.md §4.5), so there is
// no prescription-expiry trigger here; that is a documented gap, not an
// omission hidden behind a generic "order" sweep.
import { prisma } from '../db/prisma-client';
import { publish } from '../events';

export async function expireUnfulfilledOrders(now = new Date(), max = 100): Promise<number> {
  const candidates = await prisma.labOrder.findMany({
    where: { status: 'issued', expiresAt: { not: null, lte: now } },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    take: max,
    select: { id: true },
  });

  let expired = 0;
  for (const candidate of candidates) {
    const didExpire = await prisma.$transaction(async (tx) => {
      const result = await tx.labOrder.updateMany({
        where: { id: candidate.id, status: 'issued', expiresAt: { not: null, lte: now } },
        data: { status: 'expired' },
      });
      if (result.count !== 1) return false;
      await publish(tx, 'order.expired', { orderType: 'lab_order', orderId: candidate.id });
      return true;
    });
    if (didExpire) expired += 1;
  }
  return expired;
}
