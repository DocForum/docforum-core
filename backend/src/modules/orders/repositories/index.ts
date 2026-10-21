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
  items: Array<{ drugName: string; dosage: string; frequency: string; duration: string; medicationId?: string; medicationName?: string; medicationStrength?: string; medicationForm?: string; medicationRoute?: string }>;
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
  testCodes?: Array<{ labTestId: string; testCode: string; testName: string }>;
}) {
  const { testCodes, ...data } = input;
  return db.labOrder.create({
    data: { ...data, testCodes: testCodes ? { create: testCodes } : undefined },
    include: { testCodes: true },
  });
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
