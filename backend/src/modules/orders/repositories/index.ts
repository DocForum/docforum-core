import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function createConsultation(db: DbClient, input: { appointmentId: string; outcome: 'resolved' | 'referred' | 'follow_up_needed' | null; notes: string | null }) {
  return db.consultation.create({ data: input });
}

export function findConsultation(id: string, db: DbClient = prisma) {
  return db.consultation.findUnique({ where: { id } });
}

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