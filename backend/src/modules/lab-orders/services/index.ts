// lab-orders services — the only surface other modules may use to read or
// lifecycle-update a LabOrder (AGENTS.md hard rule 4).
//
// A lab order is a single-item order: its fulfillment "item" is the order
// itself (orderItemId = LabOrder.id in FulfillmentItem), so its derived
// status is binary — issued → fulfilled, no partially_fulfilled middle
// state. See ARCHITECTURE.md §5.3.
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { publish } from '../../../events';
import { record, type AuditActor } from '../../audit/services';
import type { OrderStatus } from '@prisma/client';
import * as repo from '../repositories';
import {
  formatOrderResponse,
  type FulfillOrderInput,
} from '../../pharmacy-orders/services';
import * as facilitiesService from '../../facilities/services';
import * as patientsService from '../../patients/services';

export async function getLabOrder(id: string) {
  const labOrder = await repo.findLabOrderById(id);
  if (!labOrder) throw new HttpError(404, 'Lab order not found.');
  return labOrder;
}

/**
 * Applies the fulfillment-derived order status. Called by pharmacy-orders
 * AFTER its own item rows have been written — a facility never writes a
 * LabOrder row directly (hard rule 5).
 *
 * Issue #83: the `fulfilled` transition and its `order.fulfilled` outbox
 * event commit together, so a lab order's escrow is released exactly when
 * the facility's dispense is durably recorded. A repeat call is a no-op.
 */
export async function applyFulfillmentStatus(
  labOrderId: string,
  status: Extract<OrderStatus, 'fulfilled'>,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const changed = await repo.applyOrderStatusIf(
      labOrderId,
      ['issued', 'partially_fulfilled'],
      status,
      tx,
    );
    if (changed) {
      await publish(tx, 'order.fulfilled', { orderType: 'lab_order', orderId: labOrderId });
    }
    return changed;
  });
}

export async function createLabOrder(data: {
  patientProfileId: string;
  orderingDoctorId?: string;
  details?: string;
}) {
  await patientsService.getPatientProfileById(data.patientProfileId);

  const order = await prisma.$transaction(async (tx) => {
    return repo.createOrder(tx, {
      orderType: 'lab',
      patientProfileId: data.patientProfileId,
      prescribingDoctorId: data.orderingDoctorId,
      details: data.details,
    });
  });

  return formatOrderResponse(order);
}

export async function fulfillLabOrder(
  orderId: string,
  facilityUserId: string,
  input: FulfillOrderInput,
  actor: AuditActor,
) {
  // Input shape (ids, a non-empty referenceNumber) is guaranteed by the
  // controller's Zod schema (issue #317).
  const facilityProfile = await facilitiesService.findFacilityProfileByUserId(facilityUserId);
  if (!facilityProfile) {
    throw new HttpError(403, 'Facility profile required.');
  }

  const result = await prisma.$transaction(async (tx) => {
    const existing = await repo.findOrderById(tx, orderId, 'lab');
    // An order already routed to a facility can only be fulfilled by that
    // facility; for any other facility it does not exist.
    if (!existing || (existing.facilityProfileId !== null && existing.facilityProfileId !== facilityProfile.id)) {
      throw new HttpError(404, 'Lab order not found.');
    }
    if (existing.status === 'fulfilled') {
      throw new HttpError(409, 'Lab order has already been fulfilled.');
    }
    if (existing.status !== 'issued') {
      throw new HttpError(400, `Lab order cannot be fulfilled from status: ${existing.status}`);
    }

    const marked = await repo.markOrderFulfilled(tx, orderId, facilityProfile.id);
    if (!marked) {
      throw new HttpError(409, 'Failed to transition order status to fulfilled.');
    }

    await repo.createFulfillmentProof(tx, {
      orderId,
      facilityProfileId: facilityProfile.id,
      referenceNumber: input.referenceNumber,
      notes: input.notes,
    });

    await record(tx, actor, {
      entityType: 'Order',
      entityId: orderId,
      action: 'order.fulfilled',
      fromState: 'issued',
      toState: 'fulfilled',
      metadata: {
        orderType: 'lab',
        referenceNumber: input.referenceNumber,
        facilityProfileId: facilityProfile.id,
      },
    });

    const updated = await repo.findOrderById(tx, orderId, 'lab');
    if (!updated) {
      throw new HttpError(500, 'Failed to fetch updated order.');
    }
    return updated;
  });

  return formatOrderResponse(result);
}

export async function getLabOrderById(orderId: string) {
  const order = await repo.findOrderById(prisma, orderId, 'lab');
  if (!order) {
    throw new HttpError(404, 'Lab order not found.');
  }
  return formatOrderResponse(order);
}
