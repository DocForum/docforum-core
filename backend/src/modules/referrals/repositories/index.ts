import { prisma } from '../../../db/prisma-client';
import { Prisma } from '@prisma/client';
import type { ReferralStatus } from '@prisma/client';
import type { ChainNode } from '../loop';

type DbClient = typeof prisma | Prisma.TransactionClient;

export interface CreateReferralData {
  patientProfileId: string;
  sourceConsultationId: string;
  referringDoctorId: string;
  targetDoctorId: string;
  targetSpecialtyId?: string;
  snapshotNotes: string;
  parentReferralId?: string;
  loopFlaggedAt?: Date;
  loopFlagReason?: string;
}

export function createReferral(db: DbClient, data: CreateReferralData) {
  return db.referral.create({ data });
}

export function findReferralById(db: DbClient, id: string) {
  return db.referral.findUnique({ where: { id } });
}

/**
 * The referral state machine's only write path for status transitions: a
 * conditional UPDATE that matches the expected *current* (status,
 * resultingAppointmentId) pair — the same shape as availability's
 * claimOpenSlot. Two callers racing on the same referral (a double-fired
 * cascade hook, a concurrent accept) can never both match; the loser sees
 * `count === 0`. This is what makes the cascade rules idempotent by
 * construction (issue #67), rather than trusting callers to only fire
 * once.
 */
export function updateReferralConditional(
  db: DbClient,
  expected: { id: string; status: ReferralStatus; resultingAppointmentId: string | null },
  data: {
    status?: ReferralStatus;
    resultingAppointmentId?: string | null;
    noShowCount?: number;
    referringDoctorNotifiedAt?: Date;
  },
) {
  return db.referral.updateMany({
    where: {
      id: expected.id,
      status: expected.status,
      resultingAppointmentId: expected.resultingAppointmentId,
    },
    data,
  });
}

/** Admin ops (issue #68): reassign/cancel are single-row, guarded on the
 * expected status so two admins can't both act on the same stuck
 * referral. Only ever called from the referrals service with a status the
 * service has already authorised. */
export function updateReferralIfStatus(
  db: DbClient,
  id: string,
  expectedStatus: ReferralStatus | ReferralStatus[],
  data: {
    status?: ReferralStatus;
    targetDoctorId?: string;
    cancelledReason?: string;
  },
) {
  return db.referral.updateMany({
    where: { id, status: Array.isArray(expectedStatus) ? { in: expectedStatus } : expectedStatus },
    data,
  });
}

export function listReferralsForPatient(patientProfileId: string) {
  return prisma.referral.findMany({
    where: { patientProfileId },
    include: { sourceConsultation: true },
    orderBy: { createdAt: 'desc' },
  });
}

export function listReferralsCreatedBy(referringDoctorId: string) {
  return prisma.referral.findMany({
    where: { referringDoctorId },
    orderBy: { createdAt: 'desc' },
  });
}

/** Duplicate-specialty guard (#66): any referral already hanging off this
 * consultation aimed at the same doctor or specialty. Matches ALL
 * statuses on purpose — a declined referral still means "we tried this". */
export function findByConsultationAndTarget(
  db: DbClient,
  sourceConsultationId: string,
  target: { targetDoctorId: string; targetSpecialtyId?: string | null },
) {
  return db.referral.findFirst({
    where: {
      sourceConsultationId,
      OR: [
        { targetDoctorId: target.targetDoctorId },
        ...(target.targetSpecialtyId ? [{ targetSpecialtyId: target.targetSpecialtyId }] : []),
      ],
    },
  });
}

/**
 * Issue #65: walk the ancestor chain of `fromReferralId` via its
 * parentReferralId links, nearest-first, bounded at `limit` hops. If the
 * last returned node still has a parent, the real chain is longer than
 * the bound — evaluateReferralLoop turns that into a hard rejection.
 *
 * A recursive CTE, not N round-trips: bounded depth lives in the query
 * itself, so a pathological chain can't fan out at the app layer.
 */
export async function findReferralAncestors(
  db: DbClient,
  fromReferralId: string | null,
  limit: number,
): Promise<ChainNode[]> {
  if (!fromReferralId) return [];
  const rows = await db.$queryRaw<
    {
      id: string;
      referringDoctorId: string;
      targetDoctorId: string;
      targetSpecialtyId: string | null;
      parentReferralId: string | null;
      depth: number;
    }[]
  >(Prisma.sql`
    WITH RECURSIVE referral_chain AS (
      SELECT
        r."id", r."referringDoctorId", r."targetDoctorId",
        r."targetSpecialtyId", r."parentReferralId", 1 AS depth
      FROM "Referral" r
      WHERE r."id" = ${fromReferralId}
      UNION ALL
      SELECT
        r."id", r."referringDoctorId", r."targetDoctorId",
        r."targetSpecialtyId", r."parentReferralId", c.depth + 1
      FROM "Referral" r
      JOIN referral_chain c ON r."id" = c."parentReferralId"
      WHERE c.depth < ${limit}
    )
    SELECT * FROM referral_chain ORDER BY depth
  `);
  return rows;
}

/** Lineage lookup for parentReferralId: the referral (if any) whose
 * appointment produced this consultation. */
export async function findParentReferralForConsultation(
  db: DbClient,
  sourceConsultationId: string,
): Promise<string | null> {
  const rows = await db.$queryRaw<{ referralId: string | null }[]>`
    SELECT a."referralId" AS "referralId"
    FROM "Consultation" c
    JOIN "Appointment" a ON a."id" = c."appointmentId"
    WHERE c."id" = ${sourceConsultationId}
  `;
  return rows[0]?.referralId ?? null;
}

/** Issue #68: stuck-referral / loop-flagged admin queues. Filters are
 * conjunctive; every one is optional so the same repo call serves both
 * the "stale pending" view and the "loop-flagged" view. */
export function listAdminQueue(filters: {
  status?: ReferralStatus;
  createdBefore?: Date;
  loopFlagged?: boolean;
}) {
  return prisma.referral.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.createdBefore ? { createdAt: { lt: filters.createdBefore } } : {}),
      ...(filters.loopFlagged ? { loopFlaggedAt: { not: null } } : {}),
    },
    include: {
      sourceConsultation: { select: { id: true, outcome: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
}
