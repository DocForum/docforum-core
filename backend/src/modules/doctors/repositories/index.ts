import { prisma } from '../../../db/prisma-client';
import type { Prisma, VerificationStatus } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function findDoctorProfileByUserId(userId: string, db: DbClient = prisma) {
  return db.doctorProfile.findUnique({ where: { userId } });
}

export function findSpecialties() {
  return prisma.specialty.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true } });
}

export function findSpecialtiesByIds(ids: string[], db: DbClient = prisma) {
  return db.specialty.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true } });
}

export async function replaceDoctorSpecialties(
  tx: Prisma.TransactionClient,
  doctorProfileId: string,
  specialtyIds: string[],
) {
  await tx.doctorSpecialty.deleteMany({ where: { doctorProfileId } });
  if (specialtyIds.length > 0) {
    await tx.doctorSpecialty.createMany({
      data: specialtyIds.map((specialtyId) => ({
        doctorProfileId,
        specialtyId,
        verificationStatus: 'pending',
      })),
    });
  }
}

export function searchVerifiedDoctorIds(input: {
  query: string | null;
  specialtySlug: string | null;
  cursor: string | null;
  take: number;
}) {
  const { query, specialtySlug, cursor, take } = input;
  return prisma.$queryRaw<{ id: string; fullName: string; score: number }[]>`
    WITH ranked AS (
      SELECT
        doctor."id",
        doctor."fullName",
        GREATEST(
          similarity(doctor."fullName", ${query}),
          COALESCE(MAX(similarity(specialty."name", ${query})), 0)
        ) AS score
      FROM "DoctorProfile" AS doctor
      LEFT JOIN "DoctorSpecialty" AS assignment ON assignment."doctorProfileId" = doctor."id"
      LEFT JOIN "Specialty" AS specialty ON specialty."id" = assignment."specialtyId"
      WHERE doctor."verificationStatus" = 'verified'
        AND (
          ${specialtySlug}::text IS NULL OR EXISTS (
            SELECT 1
            FROM "DoctorSpecialty" AS filter_assignment
            JOIN "Specialty" AS filter_specialty ON filter_specialty."id" = filter_assignment."specialtyId"
            WHERE filter_assignment."doctorProfileId" = doctor."id"
              AND filter_specialty."slug" = ${specialtySlug}
          )
        )
        AND (
          ${query}::text IS NULL
          OR (
            char_length(${query}) < 3
            AND (
              lower(doctor."fullName") LIKE lower(${query}) || '%'
              OR EXISTS (
                SELECT 1
                FROM "DoctorSpecialty" AS short_assignment
                JOIN "Specialty" AS short_specialty ON short_specialty."id" = short_assignment."specialtyId"
                WHERE short_assignment."doctorProfileId" = doctor."id"
                  AND lower(short_specialty."name") LIKE lower(${query}) || '%'
              )
            )
          )
          OR (
            char_length(${query}) >= 3
            AND (
              doctor."fullName" % ${query}
              OR EXISTS (
                SELECT 1
                FROM "DoctorSpecialty" AS fuzzy_assignment
                JOIN "Specialty" AS fuzzy_specialty ON fuzzy_specialty."id" = fuzzy_assignment."specialtyId"
                WHERE fuzzy_assignment."doctorProfileId" = doctor."id"
                  AND fuzzy_specialty."name" % ${query}
              )
            )
          )
        )
      GROUP BY doctor."id"
    ), cursor_row AS (
      SELECT "id", score FROM ranked WHERE "id" = ${cursor}::text
    )
    SELECT ranked."id", ranked."fullName", ranked.score
    FROM ranked
    WHERE ${cursor}::text IS NULL
      OR (
        EXISTS (SELECT 1 FROM cursor_row)
        AND (
          ranked.score < (SELECT score FROM cursor_row)
          OR (ranked.score = (SELECT score FROM cursor_row) AND ranked."id" > (SELECT "id" FROM cursor_row))
        )
      )
    ORDER BY ranked.score DESC, ranked."id" ASC
    LIMIT ${take}
  `;
}

export async function findPublicDoctorDetails(ids: string[]) {
  if (ids.length === 0) return [];
  return prisma.doctorProfile.findMany({
    where: { id: { in: ids }, verificationStatus: 'verified' },
    select: {
      id: true,
      fullName: true,
      specialties: {
        orderBy: { specialty: { name: 'asc' } },
        select: { specialty: { select: { id: true, name: true, slug: true } } },
      },
    },
  });
}

export function findDoctorProfileById(id: string, db: DbClient = prisma) {
  return db.doctorProfile.findUnique({ where: { id } });
}

export function updateDoctorProfile(id: string, version: number, fullName: string) {
  return prisma.doctorProfile
    .updateManyAndReturn({
      where: { id, version },
      data: { fullName, version: { increment: 1 } },
    })
    .then((rows) => rows[0] ?? null);
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
  return db.doctorProfile.update({ where: { id }, data: { verificationStatus: status, version: { increment: 1 } } });
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

export function findDoctorSpecialtyByDoctorAndSpecialty(doctorProfileId: string, specialtyId: string, db: DbClient = prisma) {
  return db.doctorSpecialty.findUnique({
    where: { doctorProfileId_specialtyId: { doctorProfileId, specialtyId } },
    include: { specialty: true },
  });
}

export async function updateDoctorSpecialtyVerification(
  db: DbClient,
  doctorProfileId: string,
  specialtyId: string,
  status: VerificationStatus,
  reviewer: string,
  rejectionReason?: string | null,
) {
  return db.doctorSpecialty.update({
    where: { doctorProfileId_specialtyId: { doctorProfileId, specialtyId } },
    data: {
      verificationStatus: status,
      reviewer,
      reviewDate: new Date(),
      rejectionReason: rejectionReason ?? null,
    },
    include: { specialty: true },
  });
}

export function findDoctorSpecialties(doctorProfileId: string) {
  return prisma.doctorSpecialty.findMany({
    where: { doctorProfileId },
    include: { specialty: true },
  });
}

/** Count and oldest submission time of doctors still awaiting verification. */
export async function findPendingVerificationStats(db: DbClient = prisma) {
  const [count, oldest] = await Promise.all([
    db.doctorProfile.count({ where: { verificationStatus: 'pending' } }),
    db.doctorProfile.findFirst({
      where: { verificationStatus: 'pending' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);
  return { count, oldestCreatedAt: oldest?.createdAt ?? null };
}
