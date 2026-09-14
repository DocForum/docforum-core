import { prisma } from '../../../db/prisma-client';
import type { VerificationStatus } from '@prisma/client';

export function findDoctorProfileByUserId(userId: string) {
  return prisma.doctorProfile.findUnique({ where: { userId } });
}

export function findDoctorProfileById(id: string) {
  return prisma.doctorProfile.findUnique({ where: { id } });
}

export function updateVerificationStatus(id: string, status: VerificationStatus) {
  return prisma.doctorProfile.update({ where: { id }, data: { verificationStatus: status } });
}
