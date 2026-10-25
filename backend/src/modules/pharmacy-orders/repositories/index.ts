import type { OrderType, Prisma } from '@prisma/client';

export async function findOrderById(tx: Prisma.TransactionClient, orderId: string, orderType?: OrderType) {
  return tx.order.findFirst({
    where: {
      id: orderId,
      ...(orderType ? { orderType } : {}),
    },
    include: {
      fulfillmentProofs: true,
      disputes: {
        include: {
          resolutions: true,
        },
      },
    },
  });
}

export async function createOrder(
  tx: Prisma.TransactionClient,
  data: {
    orderType: OrderType;
    patientProfileId: string;
    prescribingDoctorId?: string;
    details?: string;
  },
) {
  return tx.order.create({
    data: {
      orderType: data.orderType,
      patientProfileId: data.patientProfileId,
      prescribingDoctorId: data.prescribingDoctorId,
      details: data.details,
      status: 'issued',
    },
    include: {
      fulfillmentProofs: true,
      disputes: true,
    },
  });
}

export async function createFulfillmentProof(
  tx: Prisma.TransactionClient,
  data: {
    orderId: string;
    facilityProfileId: string;
    referenceNumber: string;
    attachmentUrl?: string;
    notes?: string;
  },
) {
  return tx.fulfillmentProof.create({
    data: {
      orderId: data.orderId,
      facilityProfileId: data.facilityProfileId,
      referenceNumber: data.referenceNumber,
      attachmentUrl: data.attachmentUrl,
      notes: data.notes,
    },
  });
}

export async function markOrderFulfilled(
  tx: Prisma.TransactionClient,
  orderId: string,
  facilityProfileId: string,
) {
  const updated = await tx.order.updateMany({
    where: {
      id: orderId,
      status: 'issued',
    },
    data: {
      status: 'fulfilled',
      fulfilledAt: new Date(),
      facilityProfileId,
    },
  });
  return updated.count > 0;
}
