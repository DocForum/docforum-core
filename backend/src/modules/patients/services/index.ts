import { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma-client';
import type { PatientProfile } from '@prisma/client';
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import * as patientsRepo from '../repositories';
import { ChunkWriter, EXPORT_SCHEMA_VERSION, ExportSectionError, writeExportBundle } from './export-bundle';
import { listExportSections, type PatientExportSection } from './export-registry';
import type { PatientExport, PatientExportStatus } from '@prisma/client';
import * as authService from '../../auth/services';

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
import { isMinor } from './majority';

export { isMinor, majorityDate } from './majority';

export async function getMyPatientProfile(userId: string) {
  const profile = await patientsRepo.findPatientProfileByUserId(userId);
  // An anonymised profile (issue #41) belongs to a deleted account: every
  // patient route resolves the caller through here, so a still-valid access
  // token stops reaching booking, listing, etc. the moment the account is
  // deleted.
  if (!profile || profile.anonymizedAt) throw new HttpError(404, 'No patient profile for this account.');
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
    // A dependent profile (issue #42) has no login, so it can never be the
    // subject of `POST /patients/me/export`; refuse rather than export it
    // without an account section.
    if (!owner?.userId) throw new ExportSectionError('profile', new Error('profile missing'));
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

// --- Account deletion (Phase 8, issue #41, docs/adr/0010) ----------------

/**
 * `DELETE /patients/me`. Anonymises the caller's identity (auth module:
 * User row; this module: PatientProfile) in one transaction and keeps every
 * clinical, order and payment record, per ADR 0010's retention table.
 *
 * Idempotent: an already-deleted account returns `alreadyDeleted: true`
 * without checking the password (it no longer has a usable one) and without
 * touching anything; two concurrent requests anonymise exactly once.
 */
export async function deleteMyAccount(
  userId: string,
  password: string,
  ip?: string | null,
): Promise<{ alreadyDeleted: boolean }> {
  if (await authService.isAccountDeleted(userId)) return { alreadyDeleted: true };
  const profile = await getMyPatientProfile(userId);

  try {
    await authService.confirmPassword(userId, password, ip);
  } catch (err) {
    // A concurrent deletion may have replaced the password between our two
    // checks; that request already did the work, so this one is a no-op.
    if (await authService.isAccountDeleted(userId)) return { alreadyDeleted: true };
    throw err;
  }

  const unusablePasswordHash = await authService.createUnusablePasswordHash();
  const deletedAt = new Date();
  const anonymized = await prisma.$transaction(async (tx) => {
    if (!(await authService.anonymizeAccount(tx, userId, { unusablePasswordHash, deletedAt }))) return false;
    await patientsRepo.anonymizeProfile(tx, profile.id, deletedAt);
    await patientsRepo.deleteExportsForPatient(tx, profile.id);
    await patientsRepo.revokeGuardianshipsOfGuardian(tx, userId, deletedAt);
    return true;
  });
  return { alreadyDeleted: !anonymized };
}

/** A module that keeps records about a patient which must survive account
 * deletion (ADR 0010). The purge never removes a profile any hold reports
 * true for. Registered in src/retention-holds.ts. */
export interface RetentionHold {
  name: string;
  holds(patientProfileId: string): Promise<boolean>;
}

const retentionHolds = new Map<string, RetentionHold>();

export function registerRetentionHold(hold: RetentionHold): void {
  const existing = retentionHolds.get(hold.name);
  if (existing && existing !== hold) throw new Error(`Retention hold "${hold.name}" is already registered.`);
  retentionHolds.set(hold.name, hold);
}

export function listRetentionHolds(): RetentionHold[] {
  return [...retentionHolds.values()];
}

/**
 * True when a delete was refused by a foreign key that still references the
 * row. Postgres reports `ON DELETE RESTRICT` as SQLSTATE 23001
 * (restrict_violation), which Prisma surfaces as an *unknown* request error
 * rather than P2003 (P2003 is 23503, what NO ACTION raises) — so both shapes
 * are checked.
 */
export function isForeignKeyRefusal(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === 'P2003';
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return /23001|violates RESTRICT setting of foreign key constraint/.test(err.message);
  }
  return false;
}

export interface PurgeResult {
  purged: number;
  held: number;
  failed: number;
}

/**
 * Scheduled purge (ADR 0010): hard-deletes tombstones only — anonymised
 * patients with no retained records, once the grace period has passed.
 * Clinical, order and payment records are never deleted (their retention
 * period is an open decision). Race-safe: holds are checked first and the
 * RESTRICT foreign keys backstop the delete, so a record created in between
 * makes that one delete fail and the account is simply kept. Re-running is a
 * no-op for everything already purged.
 */
export async function purgeDeletedPatientAccounts(now = new Date()): Promise<PurgeResult> {
  const anonymizedBefore = new Date(now.getTime() - config.accountPurge.graceHours * 60 * 60 * 1000);
  const holds = listRetentionHolds();
  if (holds.length === 0) {
    // Fail closed: with no holds registered (a wiring bug) everything would
    // look purgeable. The RESTRICT FKs would still stop it, but don't try.
    throw new Error('No retention holds registered — refusing to purge.');
  }

  const result: PurgeResult = { purged: 0, held: 0, failed: 0 };
  let cursor: string | undefined;
  for (;;) {
    const page = await patientsRepo.findAnonymizedProfilesPage(anonymizedBefore, cursor, 100);
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;

    for (const profile of page) {
      const held = await Promise.all(holds.map((hold) => hold.holds(profile.id)));
      if (held.some(Boolean)) {
        result.held += 1;
        continue;
      }
      try {
        await prisma.$transaction(async (tx) => {
          if (!(await patientsRepo.deleteAnonymizedProfile(tx, profile.id))) return;
          // Anonymised profiles always had a login (a dependent has none and
          // can't delete itself), but the column is nullable since #42.
          if (profile.userId) await authService.purgeAnonymizedAccount(tx, profile.userId);
        });
        result.purged += 1;
      } catch (err) {
        if (isForeignKeyRefusal(err)) {
          // A RESTRICT FK refused: a record exists that no hold reported yet.
          result.held += 1;
        } else {
          result.failed += 1;
          // eslint-disable-next-line no-console
          console.error(`[jobs] account purge failed for one profile: ${err instanceof Error ? err.name : typeof err}`);
        }
      }
    }
    if (page.length < 100) break;
  }
  return result;
}

// --- Guardians and dependents (Phase 8, issue #42, docs/adr/0011) --------

export interface DependentView {
  id: string;
  fullName: string;
  dateOfBirth: Date;
  guardianSince: Date;
}

function isActive(guardianship: { revokedAt: Date | null; dependentProfile: PatientProfile }, now: Date): boolean {
  const dob = guardianship.dependentProfile.dateOfBirth;
  // A dependent always has a DOB (DB CHECK); treat a missing one as inactive
  // rather than as "forever a minor".
  return guardianship.revokedAt === null && dob !== null && isMinor(dob, config.patients.ageOfMajorityYears, now);
}

function toDependentView(guardianship: { createdAt: Date; dependentProfile: PatientProfile }): DependentView {
  const profile = guardianship.dependentProfile;
  return {
    id: profile.id,
    fullName: profile.fullName,
    dateOfBirth: profile.dateOfBirth!,
    guardianSince: guardianship.createdAt,
  };
}

/**
 * Creates a new dependent profile owned by the caller (create-only — there
 * is no way to link an existing profile or account; see ADR 0011). The
 * dependent must be under the age of majority, with a DOB not in the
 * future.
 */
export async function createMyDependent(
  guardianUserId: string,
  input: { fullName: string; dateOfBirth: Date },
  now = new Date(),
): Promise<DependentView> {
  // The guardian must be a patient with their own profile (the route also
  // requires the patient role).
  await getMyPatientProfile(guardianUserId);
  if (input.dateOfBirth.getTime() > now.getTime()) {
    throw new HttpError(400, 'dateOfBirth cannot be in the future.');
  }
  if (!isMinor(input.dateOfBirth, config.patients.ageOfMajorityYears, now)) {
    throw new HttpError(
      400,
      `A dependent must be under ${config.patients.ageOfMajorityYears}. An adult needs their own account.`,
      'DEPENDENT_NOT_A_MINOR',
    );
  }
  const { profile, guardianship } = await patientsRepo.createDependentWithGuardianship({
    guardianUserId,
    fullName: input.fullName,
    dateOfBirth: input.dateOfBirth,
  });
  return toDependentView({ createdAt: guardianship.createdAt, dependentProfile: profile });
}

/** The caller's dependents they can currently act for: not revoked and still
 * under the age of majority. Never anyone else's. */
export async function listMyDependents(guardianUserId: string, now = new Date()): Promise<DependentView[]> {
  await getMyPatientProfile(guardianUserId); // 404 for a deleted account (issue #41), like every patient route
  const guardianships = await patientsRepo.findUnrevokedGuardianshipsForGuardian(guardianUserId);
  return guardianships.filter((g) => isActive(g, now)).map(toDependentView);
}

/**
 * THE authorisation check for acting on a patient profile (booking, listing
 * appointments — and every future dependent-scoped surface). Returns the
 * profile the caller may act for:
 *   - no `patientProfileId`, or the caller's own profile id -> own profile;
 *   - an active dependent of the caller -> that dependent;
 *   - a dependent whose guardianship ended (revoked / reached majority)
 *     -> 403 GUARDIANSHIP_INACTIVE;
 *   - anything else -> 404, the same as a profile that doesn't exist (no
 *     enumeration of other patients or other guardians' dependents).
 */
export async function resolveActingProfile(
  userId: string,
  patientProfileId?: string,
  now = new Date(),
): Promise<PatientProfile> {
  const own = await patientsRepo.findPatientProfileByUserId(userId);
  // A deleted account (issue #41) acts for no one — not for itself and not
  // for its former dependents — even while its access token is still valid.
  if (own?.anonymizedAt) throw new HttpError(404, 'No patient profile for this account.');
  if (!patientProfileId) {
    if (!own) throw new HttpError(404, 'No patient profile for this account.');
    return own;
  }
  if (own && own.id === patientProfileId) return own;

  const guardianship = await patientsRepo.findGuardianship(userId, patientProfileId);
  if (!guardianship) throw new HttpError(404, 'Patient profile not found.');
  if (!isActive(guardianship, now)) {
    throw new HttpError(
      403,
      'Your guardianship of this patient has ended, so you can no longer act for them.',
      'GUARDIANSHIP_INACTIVE',
    );
  }
  return guardianship.dependentProfile;
}

/** Retention hold (issues #41/#42, docs/adr/0010 + 0011): a deleted
 * guardian's tombstone stays while Guardianship rows name it — they are the
 * record of who had access to a minor's profile, and the FK is RESTRICT. */
export async function hasGuardianshipsAsGuardian(patientProfileId: string): Promise<boolean> {
  const profile = await patientsRepo.findPatientProfileById(patientProfileId);
  return profile?.userId ? patientsRepo.guardianHasGuardianships(profile.userId) : false;
}
