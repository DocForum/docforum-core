import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { storageService } from '../../../utils/storage';
import { record, type AuditActor } from '../../audit/services';
import * as repo from '../repositories';
import {
  formatOrderResponse,
  type FulfillOrderInput,
} from '../../pharmacy-orders/services';

export async function createLabOrder(data: {
  patientProfileId?: string;
  orderingDoctorId?: string;
  details?: string;
}) {
  if (!data.patientProfileId || typeof data.patientProfileId !== 'string') {
    throw new HttpError(400, 'Patient profile ID is required.');
  }

  const patient = await prisma.patientProfile.findUnique({
    where: { id: data.patientProfileId },
  });
  if (!patient) {
    throw new HttpError(404, 'Patient profile not found.');
  }

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

  const facilityProfile = await prisma.facilityProfile.findUnique({
    where: { userId: facilityUserId },
  });
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

export async function getLabOrderById(orderId: string) {
  if (!orderId || typeof orderId !== 'string') {
    throw new HttpError(400, 'Order ID is required.');
  }
  const order = await repo.findOrderById(prisma, orderId, 'lab');
  if (!order) {
    throw new HttpError(404, 'Lab order not found.');
  }
  return formatOrderResponse(order);
}
