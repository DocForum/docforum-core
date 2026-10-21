import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';

export function createIntake(patientProfileId: string, symptoms: Prisma.InputJsonValue, freeTextNotes?: string) {
  return prisma.intakeForm.create({ data: { patientProfileId, symptoms, freeTextNotes } });
}

export function findIntakesForPatient(patientProfileId: string) {
  return prisma.intakeForm.findMany({
    where: { patientProfileId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

export function findIntakesPageForPatient(patientProfileId: string, cursor: string | undefined, take: number) {
  return prisma.intakeForm.findMany({
    where: { patientProfileId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}
