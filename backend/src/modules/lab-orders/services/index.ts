// lab-orders services — the only surface other modules may use to read or
// lifecycle-update a LabOrder (AGENTS.md hard rule 4).
//
// A lab order is a single-item order: its fulfillment "item" is the order
// itself (orderItemId = LabOrder.id in FulfillmentItem), so its derived
// status is binary — issued → fulfilled, no partially_fulfilled middle
// state. See ARCHITECTURE.md §5.3.
import { HttpError } from '../../../http-error';
import * as labOrdersRepo from '../repositories';
import type { OrderStatus } from '@prisma/client';

export async function getLabOrder(id: string) {
  const labOrder = await labOrdersRepo.findLabOrderById(id);
  if (!labOrder) throw new HttpError(404, 'Lab order not found.');
  return labOrder;
}

/**
 * Applies the fulfillment-derived order status. Called by pharmacy-orders
 * AFTER its own item rows have been written — a facility never writes a
 * LabOrder row directly (hard rule 5).
 */
export async function applyFulfillmentStatus(
  labOrderId: string,
  status: Extract<OrderStatus, 'fulfilled'>,
): Promise<boolean> {
  return labOrdersRepo.applyOrderStatusIf(labOrderId, ['issued', 'partially_fulfilled'], status);
}
