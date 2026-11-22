// Lab-order expiry (Phase 4, issue #12) — with the refund trigger of
// issue #84.
//
// A lab order that was never fulfilled by its `expiresAt` moves
// `issued -> expired` through ONE conditional UPDATE (inside the lab-orders
// service), and the `order.expired` outbox event plus AuditEvent row are
// written in the SAME transaction. The payments worker therefore refunds
// exactly the orders whose expiry committed — a crashed job, a concurrent
// fulfilment, or a second process cannot refund an order that never expired.
//
// Issue #313: expiresAt is now set at issuance (issueLabOrder), so this job
// will find actual candidates instead of rows with a NULL expiresAt.
// Prescriptions have no `expiresAt` column (ARCHITECTURE.md §4.5), so there
// is no prescription-expiry trigger here — that is a documented gap.
import { prisma } from '../db/prisma-client';
import * as labOrdersService from '../modules/lab-orders/services';
import { SYSTEM_ACTOR } from '../modules/audit/services';

export async function expireUnfulfilledOrders(now = new Date(), max = 100): Promise<number> {
  const candidates = await prisma.labOrder.findMany({
    where: { status: 'issued', expiresAt: { not: null, lte: now } },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    take: max,
    select: { id: true },
  });

  let expired = 0;
  for (const candidate of candidates) {
    const didExpire = await labOrdersService.expireLabOrder(candidate.id, now, SYSTEM_ACTOR);
    if (didExpire) expired += 1;
  }
  return expired;
}
