import { prisma } from '../../../db/prisma-client';

export function findPatientProfileByUserId(userId: string) {
  return prisma.patientProfile.findUnique({ where: { userId } });
}
