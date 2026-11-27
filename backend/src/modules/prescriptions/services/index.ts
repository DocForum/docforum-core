// prescriptions services — the only surface other modules may use to read
// or lifecycle-update a Prescription (AGENTS.md hard rule 4).
import { HttpError } from '../../../http-error';
import { prisma } from '../../../db/prisma-client';
import { publish } from '../../../events';
import * as prescriptionsRepo from '../repositories';
import { recordAccess } from '../../audit/services';
import * as pharmacyOrdersService from '../../pharmacy-orders/services';
import * as paymentsService from '../../payments/services';
import type { OrderStatus } from '@prisma/client';

export async function getPrescription(id: string) {
  const prescription = await prescriptionsRepo.findPrescriptionById(id);
  if (!prescription) throw new HttpError('PRESCRIPTION_NOT_FOUND', 'Prescription not found.');
  return prescription;
}

export interface PrescriptionFulfillmentItem {
  id: string;
  label: string;
  quantityOrdered: number | null;
}

/** The item universe of a prescription — what "all items fulfilled" in
 * issue #73's order-status derivation is measured against. */
export async function getItemsForFulfillment(prescriptionId: string): Promise<PrescriptionFulfillmentItem[]> {
  await getPrescription(prescriptionId);
  const items = await prescriptionsRepo.listItems(prescriptionId);
  if (items.length === 0) {
    throw new HttpError('PRESCRIPTION_EMPTY', 'This prescription has no items to fulfill.');
  }
  // Issue #312: quantity is now on the PrescriptionItem row (nullable for
  // legacy rows pre-migration). null means the item pre-dates Phase 4 — the
  // over-dispensing guard skips the check for those items rather than
  // blocking fulfilment of historical prescriptions.
  return items.map((item) => ({ id: item.id, label: item.drugName, quantityOrdered: item.quantity ?? null }));
}

/**
 * Applies the fulfillment-derived order status (issue #73: "all items
 * fulfilled → fulfilled; some → partially_fulfilled"). Called by
 * pharmacy-orders AFTER its own item rows have been written — a facility
 * never writes a Prescription row directly (hard rule 5), and this module
 * never reaches into pharmacy-orders (hard rule 4).
 *
 * Forward-only: `partially_fulfilled` may only be applied from `issued`,
 * `fulfilled` only from `issued`/`partially_fulfilled`, so an `expired` or
 * `superseded` order can't be walked backwards into a live state.
 *
 * Issue #83: the `fulfilled` transition and its `order.fulfilled` outbox
 * event commit together, so automatic escrow release happens if and only if
 * the whole order really reached `fulfilled`. Calling this again after the
 * row already moved is a no-op and publishes nothing.
 */
export async function applyFulfillmentStatus(
  prescriptionId: string,
  status: Extract<OrderStatus, 'partially_fulfilled' | 'fulfilled'>,
): Promise<boolean> {
  const allowedFrom: OrderStatus[] =
    status === 'fulfilled' ? ['issued', 'partially_fulfilled'] : ['issued'];
  return prisma.$transaction(async (tx) => {
    const changed = await prescriptionsRepo.applyOrderStatusIf(
      prescriptionId,
      allowedFrom,
      status,
      tx,
    );
    if (changed && status === 'fulfilled') {
      await publish(tx, 'order.fulfilled', { orderType: 'prescription', orderId: prescriptionId });
    }
    return changed;
  });
}

/**
 * Issue #314: one prescription by id for an authorised viewer (see
 * pharmacyOrdersService.canViewOrder for who that is); 404 for everyone
 * else, so existence never leaks. Returns the items, status, supersession
 * links both ways and the payment intent status, and writes an AccessLog row.
 */
export async function getPrescriptionForViewer(
  prescriptionId: string,
  viewer: pharmacyOrdersService.OrderViewer,
  route: string,
) {
  const prescription = await prescriptionsRepo.findPrescriptionWithItems(prescriptionId);
  const allowed = prescription !== null && (await pharmacyOrdersService.canViewOrder(viewer, {
    orderType: 'prescription',
    id: prescription.id,
    patientProfileId: prescription.patientProfileId,
    issuingDoctorId: prescription.prescribingDoctorId,
    facilityProfileId: prescription.facilityProfileId,
  }));
  if (!prescription || !allowed) throw new HttpError('PRESCRIPTION_NOT_FOUND', 'Prescription not found.');

  recordAccess({
    accessedBy: viewer.userId,
    patientProfileId: prescription.patientProfileId,
    entityType: 'Prescription',
    entityId: prescriptionId,
    route,
  });

  const { correctedBy, amountStroops, ...rest } = prescription;
  return {
    ...rest,
    amountStroops: amountStroops.toString(),
    supersedesPrescriptionId: prescription.supersedesPrescriptionId,
    correctedByPrescriptionId: correctedBy?.id ?? null,
    paymentIntentStatus: await paymentsService.getPaymentIntentStatusForOrder('prescription', prescription.id),
  };
}
