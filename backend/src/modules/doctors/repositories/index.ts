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

export function findDoctorSpecialtyByDoctorAndSpecialty(doctorProfileId: string, specialtyId: string) {
  return prisma.doctorSpecialty.findUnique({
    where: { doctorProfileId_specialtyId: { doctorProfileId, specialtyId } },
  });
}

export function findDoctorSpecialtiesByDoctor(doctorProfileId: string) {
  return prisma.doctorSpecialty.findMany({ where: { doctorProfileId } });
}

export function updateDoctorSpecialtyVerification(
  doctorProfileId: string,
  specialtyId: string,
  status: VerificationStatus,
  reviewer: string,
  rejectionReason?: string,
) {
  const now = new Date();
  return prisma.doctorSpecialty.update({
    where: { doctorProfileId_specialtyId: { doctorProfileId, specialtyId } },
    data: {
      verificationStatus: status,
      reviewer,
      reviewDate: now,
      ...(rejectionReason !== undefined && { rejectionReason }),
    },
  });
}
