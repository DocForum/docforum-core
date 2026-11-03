// prescriptions services — the only surface other modules may use to read
// or lifecycle-update a Prescription (AGENTS.md hard rule 4).
import { HttpError } from '../../../http-error';
import * as prescriptionsRepo from '../repositories';
import type { OrderStatus } from '@prisma/client';

export async function getPrescription(id: string) {
  const prescription = await prescriptionsRepo.findPrescriptionById(id);
  if (!prescription) throw new HttpError(404, 'Prescription not found.');
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
    throw new HttpError(400, 'This prescription has no items to fulfill.');
  }
  // quantityOrdered stays null until the Phase 4 item models grow a
  // quantity field — flagged, not faked. See schema.prisma
  // FulfillmentItem.quantityOrdered.
  return items.map((item) => ({ id: item.id, label: item.drugName, quantityOrdered: null }));
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
 */
export async function applyFulfillmentStatus(
  prescriptionId: string,
  status: Extract<OrderStatus, 'partially_fulfilled' | 'fulfilled'>,
): Promise<boolean> {
  const allowedFrom: OrderStatus[] =
    status === 'fulfilled' ? ['issued', 'partially_fulfilled'] : ['issued'];
  return prescriptionsRepo.applyOrderStatusIf(prescriptionId, allowedFrom, status);
}
