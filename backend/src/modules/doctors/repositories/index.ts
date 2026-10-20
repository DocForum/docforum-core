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

export function findDoctorSpecialties(doctorProfileId: string) {
  return prisma.doctorSpecialty.findMany({
    where: { doctorProfileId },
    include: { specialty: true },
  });
}

/** Calendar feed token management (Phase 2). Tokens are stored hashed
 * so a database leak cannot be used to subscribe to a doctor's feed. */

export function findCalendarFeedTokenByHash(hash: string) {
  return prisma.doctorCalendarFeedToken.findFirst({
    where: { tokenHash: hash, revokedAt: null },
  });
}

export function findActiveCalendarFeedTokenForDoctor(doctorProfileId: string) {
  return prisma.doctorCalendarFeedToken.findFirst({
    where: { doctorProfileId: doctorProfileId, revokedAt: null },
  });
}

export function createCalendarFeedToken(db: DbClient, data: { doctorProfileId: string; tokenHash: string }) {
  return db.doctorCalendarFeedToken.create({ data });
}

export function revokeCalendarFeedTokensForDoctor(db: DbClient, doctorProfileId: string, revokedAt: Date) {
  return db.doctorCalendarFeedToken.updateMany({
    where: { doctorProfileId: doctorProfileId, revokedAt: null },
    data: { revokedAt },
  });
}
