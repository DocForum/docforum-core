import type { Prisma } from '@prisma/client';

export async function findOrderForPatient(
  tx: Prisma.TransactionClient,
  orderId: string,
  patientProfileId: string,
) {
  return tx.order.findFirst({
    where: {
      id: orderId,
      patientProfileId,
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

export async function confirmOrderReceiptConditional(
  tx: Prisma.TransactionClient,
  orderId: string,
  patientProfileId: string,
  windowStart: Date,
) {
  const result = await tx.order.updateMany({
    where: {
      id: orderId,
      patientProfileId,
      status: 'fulfilled',
      confirmed: false,
      disputed: false,
      fulfilledAt: {
        gte: windowStart,
      },
    },
    data: {
      confirmed: true,
      confirmedAt: new Date(),
      confirmationSource: 'patient',
    },
  });
  return result.count > 0;
}

export async function disputeOrderConditional(
  tx: Prisma.TransactionClient,
  orderId: string,
  patientProfileId: string,
  windowStart: Date,
) {
  const result = await tx.order.updateMany({
    where: {
      id: orderId,
      patientProfileId,
      status: 'fulfilled',
      confirmed: false,
      disputed: false,
      fulfilledAt: {
        gte: windowStart,
      },
    },
    data: {
      disputed: true,
      disputedAt: new Date(),
    },
  });
  return result.count > 0;
}

export async function createOrderDispute(
  tx: Prisma.TransactionClient,
  data: {
    orderId: string;
    patientProfileId: string;
    reason: string;
  },
) {
  return tx.orderDispute.create({
    data: {
      orderId: data.orderId,
      patientProfileId: data.patientProfileId,
      reason: data.reason,
      status: 'pending',
    },
  });
}
