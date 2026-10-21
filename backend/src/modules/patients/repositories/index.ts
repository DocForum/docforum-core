import { prisma } from '../../../db/prisma-client';
import type { PatientExportStatus } from '@prisma/client';

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
