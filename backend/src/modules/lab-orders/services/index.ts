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
import { storageService } from '../../../utils/storage';
import { record, recordAccess, type AuditActor } from '../../audit/services';
import { decryptField } from '../../../utils/field-encryption';
import type { OrderStatus } from '@prisma/client';
import * as repo from '../repositories';
import {
  formatOrderResponse,
  type FulfillOrderInput,
} from '../../pharmacy-orders/services';
import * as facilitiesService from '../../facilities/services';
import * as patientsService from '../../patients/services';
import * as pharmacyOrdersService from '../../pharmacy-orders/services';
import * as paymentsService from '../../payments/services';

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
  patientProfileId?: string;
  orderingDoctorId?: string;
  details?: string;
}) {
  if (!data.patientProfileId || typeof data.patientProfileId !== 'string') {
    throw new HttpError(400, 'Patient profile ID is required.');
  }

  await patientsService.getPatientProfileById(data.patientProfileId);

  const order = await prisma.$transaction(async (tx) => {
    return repo.createOrder(tx, {
      orderType: 'lab',
      patientProfileId: data.patientProfileId!,
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
  if (!orderId || typeof orderId !== 'string') {
    throw new HttpError(400, 'Order ID is required.');
  }

  const existingCheck = await prisma.order.findUnique({ where: { id: orderId } });
  if (!existingCheck || existingCheck.orderType !== 'lab') {
    throw new HttpError(404, 'Lab order not found.');
  }

  if (!input?.referenceNumber || typeof input.referenceNumber !== 'string' || input.referenceNumber.trim().length === 0) {
    throw new HttpError(400, 'Reference number is required for fulfillment proof.');
  }

  const facilityProfile = await facilitiesService.findFacilityProfileByUserId(facilityUserId);
  if (!facilityProfile) {
    throw new HttpError(403, 'Facility profile required.');
  }

  let attachmentUrl: string | undefined = undefined;
  if (input.attachment) {
    attachmentUrl = await storageService.uploadAttachment(input.attachment);
  }

  const result = await prisma.$transaction(async (tx) => {
    const existing = await repo.findOrderById(tx, orderId, 'lab');
    if (!existing) {
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
      referenceNumber: input.referenceNumber.trim(),
      attachmentUrl,
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
        referenceNumber: input.referenceNumber.trim(),
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

/**
 * Issue #313: expire one lab order that passed its TTL.
 *
 * Conditional update (status='issued') guards against a concurrent
 * fulfilment winning the race and an `expired` row being re-expired on the
 * next job tick.  Returns false (no-op) when the guard fails.
 */
export async function expireLabOrder(
  labOrderId: string,
  now: Date,
  actor: AuditActor,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.labOrder.updateMany({
      where: { id: labOrderId, status: 'issued', expiresAt: { not: null, lte: now } },
      data: { status: 'expired' },
    });
    if (result.count !== 1) return false;

    await publish(tx, 'order.expired', { orderType: 'lab_order', orderId: labOrderId });

    await record(tx, actor, {
      entityType: 'LabOrder',
      entityId: labOrderId,
      action: 'lab_order.expired',
      fromState: 'issued',
      toState: 'expired',
    });

    return true;
  });
}

/**
 * Issue #314: one lab order by id for an authorised viewer (see
 * pharmacyOrdersService.canViewOrder); 404 for everyone else. Notes are
 * clinical text: decrypted for the issuing doctor and admins only, `null`
 * for patients and facilities. Returns supersession links both ways and the
 * payment intent status, and writes an AccessLog row.
 */
export async function getLabOrderForViewer(
  labOrderId: string,
  viewer: pharmacyOrdersService.OrderViewer,
  route: string,
) {
  const labOrder = await repo.findLabOrderWithCorrection(labOrderId);
  const allowed = labOrder !== null && (await pharmacyOrdersService.canViewOrder(viewer, {
    orderType: 'lab_order',
    id: labOrder.id,
    patientProfileId: labOrder.patientProfileId,
    issuingDoctorId: labOrder.orderingDoctorId,
    facilityProfileId: labOrder.facilityProfileId,
  }));
  if (!labOrder || !allowed) throw new HttpError(404, 'Lab order not found.');

  recordAccess({
    accessedBy: viewer.userId,
    patientProfileId: labOrder.patientProfileId,
    entityType: 'LabOrder',
    entityId: labOrderId,
    route,
  });

  const isClinical = viewer.role === 'doctor' || viewer.role === 'admin';
  const { correctedBy, amountStroops, notes, ...rest } = labOrder;
  return {
    ...rest,
    amountStroops: amountStroops.toString(),
    notes: isClinical && notes ? decryptField(notes) : null,
    supersedesLabOrderId: labOrder.supersedesLabOrderId,
    correctedByLabOrderId: correctedBy?.id ?? null,
    paymentIntentStatus: await paymentsService.getPaymentIntentStatusForOrder('lab_order', labOrder.id),
  };
}
