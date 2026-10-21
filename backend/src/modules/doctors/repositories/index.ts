import { prisma } from '../../../db/prisma-client';
import type { Prisma, VerificationStatus } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function findDoctorProfileByUserId(userId: string) {
  return prisma.doctorProfile.findUnique({ where: { userId } });
}

export function findDoctorProfileById(id: string, db: DbClient = prisma) {
  return db.doctorProfile.findUnique({ where: { id } });
}

export function findDoctorSummariesByIds(ids: string[]) {
  return prisma.doctorProfile.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
}

/** Reads the current verification status with a row lock, inside a
 * transaction (issue #43): two admins changing it at once are serialised,
 * so each audit event records the state that was really replaced. */
export async function lockVerificationStatus(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<VerificationStatus | null> {
  const rows = await tx.$queryRaw<{ verificationStatus: VerificationStatus }[]>`
    SELECT "verificationStatus" FROM "DoctorProfile" WHERE "id" = ${id} FOR UPDATE
  `;
  return rows[0]?.verificationStatus ?? null;
}

export function updateVerificationStatus(db: DbClient, id: string, status: VerificationStatus) {
  return db.doctorProfile.update({ where: { id }, data: { verificationStatus: status } });
}

/**
 * Eligible referral recipients for a specialty (issue #6, ADR 0008):
 * verified profiles that hold the specialty, whose owning account is
 * still active. Selection among them happens in the referrals module —
 * this module only answers "who is eligible?".
 */
export function findEligibleDoctorsForSpecialty(specialtyId: string, excludeDoctorProfileIds: string[]) {
  return prisma.doctorSpecialty.findMany({
    where: {
      specialtyId,
      ...(excludeDoctorProfileIds.length > 0 ? { doctorProfileId: { notIn: excludeDoctorProfileIds } } : {}),
      doctorProfile: { verificationStatus: 'verified', user: { deactivatedAt: null } },
    },
    select: { doctorProfileId: true },
    orderBy: { doctorProfileId: 'asc' },
  });
}

export function findDoctorSpecialties(doctorProfileId: string) {
  return prisma.doctorSpecialty.findMany({
    where: { doctorProfileId },
    include: { specialty: true },
  });
}
