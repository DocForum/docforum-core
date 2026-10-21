import { prisma } from '../../../db/prisma-client';
import type { PatientExportStatus, Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function findPatientProfileByUserId(userId: string) {
  return prisma.patientProfile.findUnique({ where: { userId } });
}

// --- Patient data export (Phase 8, issue #40) ----------------------------
// PatientExport / PatientExportChunk are owned by this module. Every
// status change below is a conditional UPDATE (`updateMany` with the
// expected current state in the WHERE clause) — never read-then-write — so
// concurrent workers, cleanup and requests can't step on each other.

const IN_FLIGHT: PatientExportStatus[] = ['pending', 'processing'];

/**
 * Returns the patient's in-flight export if there is one, otherwise creates
 * a new `pending` one. The profile row is locked (`FOR UPDATE`) for the
 * duration, which serialises concurrent requests from the same patient, so
 * a double-click can't queue two generations.
 */
export function findInFlightOrCreateExport(patientProfileId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PatientProfile" WHERE "id" = ${patientProfileId} FOR UPDATE`;
    const existing = await tx.patientExport.findFirst({
      where: { patientProfileId, status: { in: IN_FLIGHT } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return { record: existing, created: false };
    const record = await tx.patientExport.create({ data: { patientProfileId } });
    return { record, created: true };
  });
}

/** Owner-scoped lookup: an export id belonging to someone else is
 * indistinguishable from one that doesn't exist. */
export function findExportForPatient(exportId: string, patientProfileId: string) {
  return prisma.patientExport.findFirst({ where: { id: exportId, patientProfileId } });
}

export function findPatientProfileOwner(patientProfileId: string) {
  return prisma.patientProfile.findUnique({ where: { id: patientProfileId }, select: { id: true, userId: true } });
}

export function findOldestPendingExportIds(limit: number) {
  return prisma.patientExport
    .findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, take: limit, select: { id: true } })
    .then((rows) => rows.map((row) => row.id));
}

export interface ClaimedExport {
  id: string;
  attempt: number;
  patientProfileId: string;
}

/** pending -> processing, bumping the attempt (fencing token), as one
 * statement: the attempt returned is exactly the one this caller claimed.
 * Null if the job wasn't pending (someone else got there first). */
export async function claimPendingExport(
  exportId: string,
  schemaVersion: number,
  startedAt: Date,
): Promise<ClaimedExport | null> {
  const rows = await prisma.$queryRaw<ClaimedExport[]>`
    UPDATE "PatientExport"
    SET "status" = 'processing', "attempt" = "attempt" + 1, "startedAt" = ${startedAt},
        "schemaVersion" = ${schemaVersion}, "updatedAt" = NOW()
    WHERE "id" = ${exportId} AND "status" = 'pending'
    RETURNING "id", "attempt", "patientProfileId"
  `;
  return rows[0] ?? null;
}

export function createExportChunk(exportId: string, attempt: number, seq: number, data: string) {
  return prisma.patientExportChunk.create({ data: { exportId, attempt, seq, data } });
}

export function findExportChunk(exportId: string, attempt: number, seq: number) {
  return prisma.patientExportChunk.findUnique({ where: { exportId_attempt_seq: { exportId, attempt, seq } } });
}

export function deleteExportChunks(exportId: string, attempt?: number) {
  return prisma.patientExportChunk
    .deleteMany({ where: attempt === undefined ? { exportId } : { exportId, attempt } })
    .then((result) => result.count);
}

/** processing -> ready, only for the attempt that is still current. */
export async function markExportReady(
  exportId: string,
  attempt: number,
  data: { generatedAt: Date; expiresAt: Date; sizeBytes: number; chunkCount: number },
): Promise<boolean> {
  const result = await prisma.patientExport.updateMany({
    where: { id: exportId, status: 'processing', attempt },
    data: { status: 'ready', ...data, failureCode: null, failedSection: null },
  });
  return result.count === 1;
}

// --- Account deletion (Phase 8, issue #41, docs/adr/0010) ----------------

/** What a deleted patient's profile shows from now on (e.g. in a doctor's
 * appointment list). */
export const ANONYMIZED_PATIENT_NAME = 'Deleted patient';

/** Anonymises the profile in place, conditional on it not already being
 * anonymised. The row (and its id) stays: appointments and payments keep
 * their foreign key to it. */
export async function anonymizeProfile(db: DbClient, profileId: string, anonymizedAt: Date): Promise<boolean> {
  const result = await db.patientProfile.updateMany({
    where: { id: profileId, anonymizedAt: null },
    data: { fullName: ANONYMIZED_PATIENT_NAME, dateOfBirth: null, anonymizedAt },
  });
  return result.count === 1;
}

/** Account deletion (issue #41, docs/adr/0010): exports are derived copies
 * of the patient's data, not records of care, so they go at anonymisation.
 * Chunks cascade. An export still being generated loses its row here, so its
 * final conditional `ready` update matches nothing and it never publishes. */
export function deleteExportsForPatient(db: DbClient, patientProfileId: string) {
  return db.patientExport.deleteMany({ where: { patientProfileId } }).then((result) => result.count);
}

/** processing -> failed, only for the attempt that is still current. */
export async function markExportFailed(
  exportId: string,
  attempt: number,
  failure: { failureCode: string; failedSection: string | null },
): Promise<boolean> {
  const result = await prisma.patientExport.updateMany({
    where: { id: exportId, status: 'processing', attempt },
    data: { status: 'failed', ...failure },
  });
  return result.count === 1;
}

export function findStaleProcessingExports(startedBefore: Date, limit: number) {
  return prisma.patientExport.findMany({
    where: { status: 'processing', startedAt: { lt: startedBefore } },
    select: { id: true, attempt: true },
    take: limit,
  });
}

/** processing -> pending for a claim presumed dead; conditional on the
 * attempt so a worker that finished in the meantime isn't undone. */
export async function requeueStaleExport(exportId: string, attempt: number): Promise<boolean> {
  const result = await prisma.patientExport.updateMany({
    where: { id: exportId, status: 'processing', attempt },
    data: { status: 'pending', startedAt: null },
  });
  return result.count === 1;
}

export function findExpiredReadyExportIds(now: Date, limit: number) {
  return prisma.patientExport
    .findMany({ where: { status: 'ready', expiresAt: { lte: now } }, select: { id: true }, take: limit })
    .then((rows) => rows.map((row) => row.id));
}

/** ready -> expired and the artifact deleted, in one transaction. Only the
 * row's own chunks are touched; the metadata row stays (no patient data in
 * it) so a later status read answers "expired" rather than "not found". */
export async function expireExport(exportId: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.patientExport.updateMany({
      where: { id: exportId, status: 'ready', expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
    if (result.count !== 1) return false;
    await tx.patientExportChunk.deleteMany({ where: { exportId } });
    return true;
  });
}

/** Chunks that can never be served: any attempt other than the export's
 * current one (a superseded or crashed claim), and anything belonging to a
 * failed or expired export. */
export function deleteUnservableExportChunks(): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "PatientExportChunk" c
    USING "PatientExport" e
    WHERE c."exportId" = e."id"
      AND (c."attempt" <> e."attempt" OR e."status" IN ('failed', 'expired'))
  `;
}

export function findPatientProfileById(id: string) {
  return prisma.patientProfile.findUnique({ where: { id } });
}
/** One keyset page of anonymised profiles old enough to be purge
 * candidates. */
export function findAnonymizedProfilesPage(anonymizedBefore: Date, cursor: string | undefined, take: number) {
  return prisma.patientProfile.findMany({
    where: { anonymizedAt: { lte: anonymizedBefore } },
    select: { id: true, userId: true },
    orderBy: { id: 'asc' },
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/** Hard-deletes an anonymised profile. Conditional on `anonymizedAt` being
 * set, so a live profile can never be removed here; and every clinical or
 * payment table references the profile with ON DELETE RESTRICT, so a row
 * that still has records makes this throw instead of cascading. */
export async function deleteAnonymizedProfile(db: DbClient, profileId: string): Promise<boolean> {
  const result = await db.patientProfile.deleteMany({ where: { id: profileId, anonymizedAt: { not: null } } });
  return result.count === 1;
}

// --- Guardians and dependents (Phase 8, issue #42, docs/adr/0011) --------

/** Creates a login-less dependent profile and its guardianship together:
 * a dependent with no guardian (or a guardianship with no dependent) is
 * never observable. */
export function createDependentWithGuardianship(input: {
  guardianUserId: string;
  fullName: string;
  dateOfBirth: Date;
}) {
  return prisma.$transaction(async (tx) => {
    const profile = await tx.patientProfile.create({
      data: { userId: null, fullName: input.fullName, dateOfBirth: input.dateOfBirth },
    });
    const guardianship = await tx.guardianship.create({
      data: { guardianUserId: input.guardianUserId, dependentProfileId: profile.id },
    });
    return { profile, guardianship };
  });
}

/** The guardian's non-revoked guardianships with their dependent profiles.
 * Majority is applied by the service (it needs the configured age). */
export function findUnrevokedGuardianshipsForGuardian(guardianUserId: string) {
  return prisma.guardianship.findMany({
    where: { guardianUserId, revokedAt: null },
    include: { dependentProfile: true },
    orderBy: { createdAt: 'asc' },
  });
}

/** The guardianship between this guardian and this profile, if any (revoked
 * or not), with the dependent profile. */
export function findGuardianship(guardianUserId: string, dependentProfileId: string) {
  return prisma.guardianship.findUnique({
    where: { guardianUserId_dependentProfileId: { guardianUserId, dependentProfileId } },
    include: { dependentProfile: true },
  });
}

/** Account deletion (issues #41/#42, docs/adr/0010 + 0011): a deleted
 * guardian's access to their dependents ends with the account. Revoked, never
 * deleted — the rows are the record of who had access and when. */
export function revokeGuardianshipsOfGuardian(db: DbClient, guardianUserId: string, revokedAt: Date) {
  return db.guardianship
    .updateMany({ where: { guardianUserId, revokedAt: null }, data: { revokedAt } })
    .then((result) => result.count);
}

export async function guardianHasGuardianships(guardianUserId: string): Promise<boolean> {
  return (await prisma.guardianship.findFirst({ where: { guardianUserId }, select: { id: true } })) !== null;
}
