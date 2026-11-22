// prescriptions repositories — Prescription/PrescriptionItem data access
// only. Cross-module callers (pharmacy-orders) must go through
// ../services, never import this file — see AGENTS.md hard rule 4.
import { prisma } from '../../../db/prisma-client';
import type { OrderStatus, Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function findPrescriptionById(id: string) {
  return prisma.prescription.findUnique({ where: { id } });
}

/** Issue #314: full prescription + items for the detail-read endpoint. */
export function findPrescriptionWithItems(id: string) {
  return prisma.prescription.findUnique({
    where: { id },
    include: {
      items: {
        select: {
          id: true,
          drugName: true,
          dosage: true,
          frequency: true,
          duration: true,
          quantity: true,
          unit: true,
          medicationId: true,
          flaggedForPharmacistReview: true,
        },
      },
    },
  });
}

export function listItems(prescriptionId: string) {
  // No orderBy: PrescriptionItem has no created_at (ARCHITECTURE.md §4.5),
  // and the item universe is order-insensitive for the derivation.
  return prisma.prescriptionItem.findMany({
    where: { prescriptionId },
    // Issue #312: quantity included so getItemsForFulfillment can populate
    // FulfillmentItem.quantityOrdered for over-dispensing checks.
    select: { id: true, drugName: true, quantity: true },
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
  db: DbClient = prisma,
): Promise<boolean> {
  return db.prescription
    .updateMany({ where: { id, status: { in: allowedFrom } }, data: { status: to } })
    .then((result) => result.count === 1);
}

/** Returns the patientProfileId for a prescription — used by cross-module
 * callers that need to verify ownership (issue #323). */
export function findPatientProfileIdForPrescription(id: string) {
  return prisma.prescription
    .findUnique({ where: { id }, select: { patientProfileId: true } })
    .then((row) => row?.patientProfileId ?? null);
}
