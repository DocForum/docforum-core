// lab-orders repositories — LabOrder data access only. Cross-module
// callers (pharmacy-orders) must go through ../services, never import
// this file — see AGENTS.md hard rule 4.
import { prisma } from '../../../db/prisma-client';
import type { OrderStatus } from '@prisma/client';

export function findLabOrderById(id: string) {
  return prisma.labOrder.findUnique({ where: { id } });
}

/**
 * Conditional, forward-only lifecycle update driven by item-level
 * fulfillment (issue #73) — same shape as prescriptions'
 * `applyOrderStatusIf`: allowed current statuses are in the WHERE clause,
 * so an `expired`/`superseded` order can never be walked back into a live
 * state, and concurrent derivations can't downgrade each other.
 */
export function applyOrderStatusIf(
  id: string,
  allowedFrom: OrderStatus[],
  to: OrderStatus,
): Promise<boolean> {
  return prisma.labOrder
    .updateMany({ where: { id, status: { in: allowedFrom } }, data: { status: to } })
    .then((result) => result.count === 1);
}
