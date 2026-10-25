import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { storageService, type UploadAttachmentOptions } from '../../../utils/storage';
import { computeConfirmedSignal, formatOrderResponse } from '../../../utils/order-utils';
import { record, type AuditActor } from '../../audit/services';
import * as repo from '../repositories';

export { computeConfirmedSignal, formatOrderResponse };

export interface FulfillOrderInput {
  referenceNumber: string;
  attachment?: string | UploadAttachmentOptions;
  notes?: string;
}

export async function createPharmacyOrder(data: {
  patientProfileId?: string;
  prescribingDoctorId?: string;
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
      orderType: 'pharmacy',
      patientProfileId: data.patientProfileId!,
      prescribingDoctorId: data.prescribingDoctorId,
      details: data.details,
    });
  });

  return formatOrderResponse(order);
}

export async function fulfillPharmacyOrder(
  orderId: string,
  facilityUserId: string,
  input: FulfillOrderInput,
  actor: AuditActor,
) {
  if (!orderId || typeof orderId !== 'string') {
    throw new HttpError(400, 'Order ID is required.');
  }

  const existingCheck = await prisma.order.findUnique({ where: { id: orderId } });
  if (!existingCheck || existingCheck.orderType !== 'pharmacy') {
    throw new HttpError(404, 'Pharmacy order not found.');
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
    const existing = await repo.findOrderById(tx, orderId, 'pharmacy');
    if (!existing) {
      throw new HttpError(404, 'Pharmacy order not found.');
    }
    if (existing.status === 'fulfilled') {
      throw new HttpError(409, 'Pharmacy order has already been fulfilled.');
    }
    if (existing.status !== 'issued') {
      throw new HttpError(400, `Pharmacy order cannot be fulfilled from status: ${existing.status}`);
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
        orderType: 'pharmacy',
        referenceNumber: input.referenceNumber.trim(),
        facilityProfileId: facilityProfile.id,
      },
    });

    const updated = await repo.findOrderById(tx, orderId, 'pharmacy');
    if (!updated) {
      throw new HttpError(500, 'Failed to fetch updated order.');
    }
    return updated;
  });

  return formatOrderResponse(result);
}

export async function getPharmacyOrderById(orderId: string) {
  if (!orderId || typeof orderId !== 'string') {
    throw new HttpError(400, 'Order ID is required.');
  }
  const order = await repo.findOrderById(prisma, orderId, 'pharmacy');
  if (!order) {
    throw new HttpError(404, 'Pharmacy order not found.');
  }
  return formatOrderResponse(order);
}
