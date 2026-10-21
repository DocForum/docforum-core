// prescriptions repositories — data access only. Not to be imported
// by other modules directly — go through services/ instead.
import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export async function findPrescriptionForCorrection(id: string, db: DbClient = prisma) {
  return db.prescription.findUnique({ where: { id }, include: { correctedBy: true } });
}

export async function createPrescription(db: DbClient, input: {
  consultationId: string; patientProfileId: string; prescribingDoctorId: string;
  facilityProfileId: string; amountStroops: bigint; supersedesPrescriptionId: string | null;
  items: Array<{ drugName: string; dosage: string; frequency: string; duration: string; medicationId?: string; medicationName?: string; medicationStrength?: string; medicationForm?: string; medicationRoute?: string }>;
}) {
  const { items, ...data } = input;
  return db.prescription.create({ data: { ...data, items: { create: items } }, include: { items: true } });
}

export async function findPrescriptionById(id: string, db: DbClient = prisma) {
  return db.prescription.findUnique({
    where: { id },
    include: { items: { include: { medication: true } } },
  });
}

export async function findPrescriptionsByPatient(patientProfileId: string, db: DbClient = prisma) {
  return db.prescription.findMany({
    where: { patientProfileId },
    orderBy: { createdAt: 'desc' },
    include: { items: { include: { medication: true } } },
  });
}