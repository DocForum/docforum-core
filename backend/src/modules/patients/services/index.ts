import { HttpError } from '../../../http-error';
import { config } from '../../../config';
import * as patientsRepo from '../repositories';
import { ChunkWriter, EXPORT_SCHEMA_VERSION, ExportSectionError, writeExportBundle } from './export-bundle';
import { listExportSections, type PatientExportSection } from './export-registry';
import type { PatientExport, PatientExportStatus } from '@prisma/client';

// The registry is part of this module's service surface: other modules
// import `PatientExportSection`/`paginate` from here to build their section,
// and src/export-sections.ts registers them.
export {
  paginate,
  registerExportSection,
  unregisterExportSection,
  listExportSections,
} from './export-registry';
export type { ExportSubject, PatientExportSection } from './export-registry';
export { EXPORT_FORMAT, EXPORT_SCHEMA_VERSION } from './export-bundle';

export async function getMyPatientProfile(userId: string) {
  const profile = await patientsRepo.findPatientProfileByUserId(userId);
  if (!profile) throw new HttpError(404, 'No patient profile for this account.');
  return profile;
}

/** This module's own export section: the profile itself. A single item. */
export const profileExportSection: PatientExportSection = {
  name: 'profile',
  version: 1,
  async *pages(subject) {
    const profile = await patientsRepo.findPatientProfileByUserId(subject.userId);
    if (!profile || profile.id !== subject.patientProfileId) return;
    yield [
      {
        id: profile.id,
        fullName: profile.fullName,
        dateOfBirth: profile.dateOfBirth,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      },
    ];
  },
};

// --- Patient data export (Phase 8, issue #40) ----------------------------

export interface PatientExportView {
  id: string;
  status: PatientExportStatus;
  schemaVersion: number | null;
  createdAt: Date;
  startedAt: Date | null;
  generatedAt: Date | null;
  expiresAt: Date | null;
  sizeBytes: number | null;
  failure: { code: string; section: string | null } | null;
  downloadUrl: string | null;
}

/** A `ready` export whose deadline has passed is reported (and treated) as
 * expired immediately — the cleanup job only catches up on the storage. */
function effectiveStatus(record: PatientExport, now: Date): PatientExportStatus {
  if (record.status === 'ready' && (!record.expiresAt || record.expiresAt.getTime() <= now.getTime())) {
    return 'expired';
  }
  return record.status;
}

function toView(record: PatientExport, now = new Date()): PatientExportView {
  const status = effectiveStatus(record, now);
  return {
    id: record.id,
    status,
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    generatedAt: record.generatedAt,
    expiresAt: record.expiresAt,
    sizeBytes: status === 'ready' ? record.sizeBytes : null,
    failure: record.failureCode ? { code: record.failureCode, section: record.failedSection } : null,
    downloadUrl: status === 'ready' ? `/patients/me/export/${record.id}/download` : null,
  };
}

type ExportRequestedListener = () => void;
let exportRequestedListener: ExportRequestedListener | null = null;

/** src/jobs registers here so a new request starts generating at once
 * instead of waiting for the next interval tick. Unset in tests, which
 * drive the worker explicitly. */
export function onExportRequested(listener: ExportRequestedListener | null): void {
  exportRequestedListener = listener;
}

/**
 * Starts (or returns the already-running) export for the caller's own
 * profile. The subject is always derived from the authenticated user —
 * there is deliberately no way to name another patient here.
 */
export async function requestMyExport(userId: string): Promise<{ export: PatientExportView; created: boolean }> {
  const profile = await getMyPatientProfile(userId);
  const { record, created } = await patientsRepo.findInFlightOrCreateExport(profile.id);
  if (created) exportRequestedListener?.();
  return { export: toView(record), created };
}

async function findMyExport(userId: string, exportId: string): Promise<PatientExport> {
  const profile = await getMyPatientProfile(userId);
  const record = await patientsRepo.findExportForPatient(exportId, profile.id);
  // 404, not 403, for someone else's id: don't confirm it exists.
  if (!record) throw new HttpError(404, 'Export not found.');
  return record;
}

export async function getMyExport(userId: string, exportId: string): Promise<PatientExportView> {
  return toView(await findMyExport(userId, exportId));
}

export interface ExportDownload {
  filename: string;
  sizeBytes: number;
  /** Yields the stored chunks in order, one database read per chunk. Throws
   * if the artifact disappears mid-stream (cleanup raced the download). */
  chunks(): AsyncGenerator<string>;
}

export async function openMyExportDownload(userId: string, exportId: string): Promise<ExportDownload> {
  const record = await findMyExport(userId, exportId);
  const status = effectiveStatus(record, new Date());
  if (status === 'expired') {
    throw new HttpError(410, 'This export has expired. Request a new one.', 'EXPORT_EXPIRED');
  }
  if (status !== 'ready' || record.chunkCount === null || record.sizeBytes === null) {
    throw new HttpError(409, `This export is '${status}', not ready to download.`, 'EXPORT_NOT_READY');
  }
  const { attempt, chunkCount } = record;
  return {
    filename: `docforum-export-${record.id}.json`,
    sizeBytes: record.sizeBytes,
    async *chunks() {
      for (let seq = 0; seq < chunkCount; seq += 1) {
        const chunk = await patientsRepo.findExportChunk(record.id, attempt, seq);
        if (!chunk) throw new Error('EXPORT_ARTIFACT_MISSING');
        yield chunk.data;
      }
    },
  };
}

function exportTtlMs(): number {
  return config.patientExport.ttlHours * 60 * 60 * 1000;
}

/**
 * Generates one claimed export. Sections run strictly one after another and
 * page through their data, and the bundle is flushed to storage chunk by
 * chunk, so memory is bounded by pageSize rows + one chunk regardless of how
 * long the patient's history is.
 */
async function generateClaimedExport(
  record: patientsRepo.ClaimedExport,
  sections: PatientExportSection[],
): Promise<PatientExportStatus> {
  const { id: exportId, attempt } = record;
  const writer = new ChunkWriter(
    { writeChunk: (seq, data) => patientsRepo.createExportChunk(exportId, attempt, seq, data).then(() => undefined) },
    config.patientExport.chunkBytes,
  );
  const generatedAt = new Date();

  try {
    // The owning user is needed by account-level sections (auth module).
    const owner = await patientsRepo.findPatientProfileOwner(record.patientProfileId);
    if (!owner) throw new ExportSectionError('profile', new Error('profile missing'));
    await writeExportBundle({
      exportId,
      generatedAt,
      subject: { patientProfileId: owner.id, userId: owner.userId },
      sections,
      pageSize: config.patientExport.pageSize,
      writer,
    });
  } catch (err) {
    const section = err instanceof ExportSectionError ? err.section : null;
    // Log the error *type* only — a driver or section error message can
    // echo the data it was handling.
    const cause = err instanceof ExportSectionError ? err.cause : err;
    // eslint-disable-next-line no-console
    console.error(
      `[jobs] patient export ${exportId} attempt ${attempt} failed${section ? ` in section "${section}"` : ''}: ${
        cause instanceof Error ? cause.name : typeof cause
      }`,
    );
    await patientsRepo.deleteExportChunks(exportId, attempt);
    await patientsRepo.markExportFailed(exportId, attempt, {
      failureCode: section ? 'SECTION_FAILED' : 'GENERATION_FAILED',
      failedSection: section,
    });
    return 'failed';
  }

  const published = await patientsRepo.markExportReady(exportId, attempt, {
    generatedAt,
    expiresAt: new Date(generatedAt.getTime() + exportTtlMs()),
    sizeBytes: writer.totalBytes,
    chunkCount: writer.chunkCount,
  });
  if (!published) {
    // Our claim was superseded (presumed dead and requeued). The newer
    // attempt owns the export; drop what we wrote.
    await patientsRepo.deleteExportChunks(exportId, attempt);
    return 'processing';
  }
  return 'ready';
}

/** Claims and generates one export by id. Returns the resulting status, or
 * null if the job wasn't `pending` (someone else claimed it). Exposed for
 * tests; production goes through `runExportWorker`. */
export async function processExport(
  exportId: string,
  sections: PatientExportSection[] = listExportSections(),
): Promise<PatientExportStatus | null> {
  const claimed = await patientsRepo.claimPendingExport(exportId, EXPORT_SCHEMA_VERSION, new Date());
  if (!claimed) return null;
  return generateClaimedExport(claimed, sections);
}

/**
 * Requeues `processing` jobs whose claim is older than the stale timeout
 * (the worker died mid-generation), or fails them once they've used up
 * their attempts. Conditional on the attempt number, so a slow-but-alive
 * worker that finishes first wins and is not undone.
 */
export async function recoverStaleExports(now = new Date()): Promise<{ requeued: number; failed: number }> {
  const staleBefore = new Date(now.getTime() - config.patientExport.staleAfterSeconds * 1000);
  const stale = await patientsRepo.findStaleProcessingExports(staleBefore, 100);
  let requeued = 0;
  let failed = 0;
  for (const job of stale) {
    if (job.attempt >= config.patientExport.maxAttempts) {
      if (await patientsRepo.markExportFailed(job.id, job.attempt, { failureCode: 'GENERATION_TIMEOUT', failedSection: null })) {
        failed += 1;
      }
    } else if (await patientsRepo.requeueStaleExport(job.id, job.attempt)) {
      requeued += 1;
    }
  }
  return { requeued, failed };
}

/** One worker pass: recover dead claims, then generate pending exports
 * oldest-first, one at a time (never in parallel — generation is the
 * expensive part, and a burst of requests must not multiply memory use). */
export async function runExportWorker(maxJobs = 10): Promise<{ processed: number }> {
  await recoverStaleExports();
  let processed = 0;
  for (const exportId of await patientsRepo.findOldestPendingExportIds(maxJobs)) {
    if ((await processExport(exportId)) !== null) processed += 1;
  }
  return { processed };
}

/** Cleanup pass: expire `ready` exports past their deadline (deleting their
 * artifact), then sweep chunks that can never be served. Only this module's
 * export rows are touched. */
export async function expireExports(now = new Date()): Promise<{ expired: number; orphanChunksDeleted: number }> {
  let expired = 0;
  for (;;) {
    const ids = await patientsRepo.findExpiredReadyExportIds(now, 100);
    if (ids.length === 0) break;
    let progressed = 0;
    for (const id of ids) {
      if (await patientsRepo.expireExport(id, now)) progressed += 1;
    }
    expired += progressed;
    if (ids.length < 100 || progressed === 0) break;
  }
  const orphanChunksDeleted = await patientsRepo.deleteUnservableExportChunks();
  return { expired, orphanChunksDeleted };
}

export async function getPatientProfileById(id: string) {
  const profile = await patientsRepo.findPatientProfileById(id);
  if (!profile) throw new HttpError(404, 'Patient profile not found.');
  return profile;
}
