import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

// Consultation rows are owned by the consultations module; this module goes
// through its services (see orders/services) rather than writing them here.

export function findPrescriptionForCorrection(id: string, db: DbClient = prisma) {
  return db.prescription.findUnique({ where: { id }, include: { correctedBy: true } });
}

export function createPrescription(db: DbClient, input: {
  consultationId: string; patientProfileId: string; prescribingDoctorId: string;
  facilityProfileId: string; amountStroops: bigint; supersedesPrescriptionId: string | null;
  items: Array<{ drugName: string; dosage: string; frequency: string; duration: string }>;
}) {
  const { items, ...data } = input;
  return db.prescription.create({ data: { ...data, items: { create: items } }, include: { items: true } });
}

export function findLabOrderForCorrection(id: string, db: DbClient = prisma) {
  return db.labOrder.findUnique({ where: { id }, include: { correctedBy: true } });
}

export function createLabOrder(db: DbClient, input: {
  consultationId: string; patientProfileId: string; orderingDoctorId: string;
  facilityProfileId: string; amountStroops: bigint; testType: string; urgency: 'routine' | 'urgent';
  notes: string | null; supersedesLabOrderId: string | null;
}) {
  return db.labOrder.create({ data: input });
}

export function findPrescriptionExportPage(patientProfileId: string, cursor: string | undefined, take: number) {
  return prisma.prescription.findMany({
    where: { patientProfileId }, orderBy: [{ id: 'asc' }], take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { items: true },
  });
}

export function findLabOrderExportPage(patientProfileId: string, cursor: string | undefined, take: number) {
  return prisma.labOrder.findMany({
    where: { patientProfileId }, orderBy: [{ id: 'asc' }], take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { result: true },
  });
}

export async function patientHasOrders(patientProfileId: string): Promise<boolean> {
  const [prescription, labOrder] = await Promise.all([
    prisma.prescription.findFirst({ where: { patientProfileId }, select: { id: true } }),
    prisma.labOrder.findFirst({ where: { patientProfileId }, select: { id: true } }),
  ]);
  return prescription !== null || labOrder !== null;
}

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
