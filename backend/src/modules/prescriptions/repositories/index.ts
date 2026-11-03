// prescriptions repositories — Prescription/PrescriptionItem data access
// only. Cross-module callers (pharmacy-orders) must go through
// ../services, never import this file — see AGENTS.md hard rule 4.
import { prisma } from '../../../db/prisma-client';
import type { OrderStatus } from '@prisma/client';

export function findPrescriptionById(id: string) {
  return prisma.prescription.findUnique({ where: { id } });
}

export function listItems(prescriptionId: string) {
  // No orderBy: PrescriptionItem has no created_at (ARCHITECTURE.md §4.5),
  // and the item universe is order-insensitive for the derivation.
  return prisma.prescriptionItem.findMany({
    where: { prescriptionId },
    select: { id: true, drugName: true },
  });
}

/**
 * Conditional, forward-only lifecycle update driven by item-level
 * fulfillment (issue #73). Same shape as availability's `claimOpenSlot`:
 * the allowed current statuses are part of the WHERE clause, so this can
 * never resurrect an `expired`/`superseded` order and can never race a
 * concurrent derivation into a downgrade. Returns whether a row actually
 * transitioned.
 */
export function applyOrderStatusIf(
  id: string,
  allowedFrom: OrderStatus[],
  to: OrderStatus,
): Promise<boolean> {
  return prisma.prescription
    .updateMany({ where: { id, status: { in: allowedFrom } }, data: { status: to } })
    .then((result) => result.count === 1);
}
