// audit services (Phase 8, issue #43) — the write helper every module calls
// when it changes the state of an accountable record, plus the admin query.
// Other modules import from here only, never from audit/repositories.
//
// The contract of record():
//   - it runs INSIDE the transaction of the change it describes (it refuses
//     the root client), so an event exists if and only if its change
//     committed;
//   - it carries only what's needed to attribute the transition — actor,
//     entity, action, from/to state, request id — plus a small, flat,
//     validated metadata map of ids/codes. Never PHI, never request bodies.
import type { Prisma, Role } from '@prisma/client';
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import * as auditRepo from '../repositories';

/** Who caused a transition. Controllers build it from the request with
 * `auditActor(req)` (src/middleware/request-id.ts). `userId`/`role` are null
 * only for system-initiated changes. */
export interface AuditActor {
  userId: string | null;
  role: Role | null;
  requestId: string | null;
}

export const SYSTEM_ACTOR: AuditActor = { userId: null, role: null, requestId: null };

export type AuditEntityType =
  | 'Appointment'
  | 'DoctorProfile'
  | 'PaymentIntent'
  | 'Consultation'
  | 'Prescription'
  | 'LabOrder'
  | 'Referral'
  | 'FacilityPrice'
  // Issue #14: admin-only facility account creation (`facility.created`).
  | 'FacilityProfile'
  | 'Order'
  | 'OrderDispute'
  | 'FeatureFlag';

export type AuditMetadataValue = string | number | boolean | null;
export type AuditMetadata = Record<string, AuditMetadataValue>;

export interface AuditEventInput {
  entityType: AuditEntityType;
  entityId: string;
  action: string;
  fromState: string | null;
  toState: string | null;
  metadata?: AuditMetadata;
}

const ACTION = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
const METADATA_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const MAX_METADATA_KEYS = 16;
const MAX_METADATA_STRING = 200;
/** Defence in depth against a caller passing personal or secret data: any
 * key that *looks* like it could carry it is refused outright. Callers
 * should only ever pass ids and codes. */
const FORBIDDEN_METADATA_KEY =
  /(name|email|phone|dob|birth|address|note|intake|symptom|diagnos|password|secret|token|key|credential|body|payload)/i;

export class AuditMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditMetadataError';
  }
}

/** Validates metadata: flat scalars only, bounded, no suspicious keys.
 * Exported for tests. Throws AuditMetadataError — a programming error, so
 * it aborts the surrounding transaction rather than being swallowed. */
export function validateAuditMetadata(metadata: AuditMetadata | undefined): AuditMetadata | undefined {
  if (metadata === undefined) return undefined;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new AuditMetadataError('Audit metadata must be a flat object.');
  }
  const entries = Object.entries(metadata);
  if (entries.length > MAX_METADATA_KEYS) throw new AuditMetadataError('Audit metadata has too many keys.');
  for (const [key, value] of entries) {
    if (!METADATA_KEY.test(key)) throw new AuditMetadataError(`Invalid audit metadata key: ${key}`);
    if (FORBIDDEN_METADATA_KEY.test(key) && !/Id$/.test(key)) {
      throw new AuditMetadataError(`Audit metadata key not allowed (could carry personal or secret data): ${key}`);
    }
    const ok =
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= MAX_METADATA_STRING);
    if (!ok) throw new AuditMetadataError(`Audit metadata value for ${key} must be a short scalar.`);
  }
  return metadata;
}

/**
 * Records one state transition, inside the caller's transaction. Passing
 * the root Prisma client (which would commit the event on its own, before
 * — or without — the change) is refused at runtime.
 *
 * The root client is recognised by its lifecycle methods ($connect /
 * $disconnect): they exist on the root client and never on the
 * interactive-transaction client. It used to be recognised by
 * `$transaction` instead, but Prisma 7 (the issue #47 upgrade) gives the
 * transaction client a `$transaction` method too — identical to the root
 * client's — so that check started refusing every *legitimate* in-transaction
 * call, aborting the change with it. Verified against prisma@7.10.1.
 */
export async function record(tx: Prisma.TransactionClient, actor: AuditActor, event: AuditEventInput): Promise<void> {
  const client = tx as unknown as { $connect?: unknown; $disconnect?: unknown };
  if (typeof client.$connect === 'function' || typeof client.$disconnect === 'function') {
    throw new Error('audit.record() must run inside the transaction of the change it describes.');
  }
  if (!ACTION.test(event.action)) throw new Error(`Invalid audit action: ${event.action}`);
  const metadata = validateAuditMetadata(event.metadata);
  await auditRepo.insertAuditEvent(tx, {
    actorUserId: actor.userId,
    actorRole: actor.role,
    entityType: event.entityType,
    entityId: event.entityId,
    action: event.action,
    fromState: event.fromState,
    toState: event.toState,
    requestId: actor.requestId,
    metadata,
  });
}

// --- Admin query -----------------------------------------------------------

export interface AuditEventFilters {
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

/** Opaque cursor: base64url of "<createdAt ISO>|<id>" of the last item. */
export function encodeAuditCursor(event: { createdAt: Date; id: string }): string {
  return Buffer.from(`${event.createdAt.toISOString()}|${event.id}`, 'utf8').toString('base64url');
}

export function decodeAuditCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf('|');
  const createdAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (separator < 1 || Number.isNaN(createdAt.getTime()) || !id) {
    throw new HttpError(400, 'Invalid cursor.', 'INVALID_CURSOR');
  }
  return { createdAt, id };
}

export async function listAuditEvents(filters: AuditEventFilters) {
  if (filters.from && filters.to && filters.from.getTime() > filters.to.getTime()) {
    throw new HttpError(400, '`from` must not be after `to`.');
  }
  const rows = await auditRepo.findAuditEvents({
    entityType: filters.entityType,
    entityId: filters.entityId,
    actorUserId: filters.actorUserId,
    from: filters.from,
    to: filters.to,
    before: filters.cursor ? decodeAuditCursor(filters.cursor) : undefined,
    // One extra row tells us whether there's a next page without a count.
    take: filters.limit + 1,
  });
  const items = rows.slice(0, filters.limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > filters.limit && last ? encodeAuditCursor(last) : null };
}

// --- PHI read-access logging (Phase 8, issue #45) ---------------------------
// Answers "who looked at this" — distinct from record()'s "who changed this".
// Writes are fire-and-forget (never awaited on the read path) and fail
// open: a logging failure must never fail the read, but it IS counted and
// surfaced for alerting via GET /admin/access-logs/stats.

/** Entity kinds a read can be logged against. Mirrors the schema comment
 * on AccessLog.entityType — extend both together. */
export type AccessEntityType =
  | 'IntakeForm'
  | 'Consultation'
  | 'Prescription'
  | 'PrescriptionItem'
  | 'LabOrder'
  | 'LabResult'
  | 'Referral'
  | 'PaymentIntent'
  | 'PatientProfile'
  | 'Appointment';

export interface AccessLogInput {
  /** The viewer. Null only for anonymous/system reads (there are none today). */
  accessedBy?: string | null;
  /** The record owner (whose data was viewed) — used by the patient-facing
   * /patients/me/access-log. Null when the read isn't attributable to one. */
  patientProfileId?: string | null;
  entityType: AccessEntityType;
  entityId: string;
  route?: string | null;
  /** Context string — no PHI, just enough to correlate with request logs. */
  detail?: string | null;
}

/** Retention window for AccessLog rows (env ACCESS_LOG_RETENTION_DAYS).
 * pruneOldAccessLogs() deletes anything older; wired into the prune
 * interval in src/server.ts. */
export const ACCESS_LOG_RETENTION_DAYS = config.accessLog.retentionDays;

let logFailureCount = 0;

/** Cumulative count of failed access-log writes since process start —
 * readable by admins via GET /admin/access-logs/stats for alerting. */
export function getLogFailureCount(): number {
  return logFailureCount;
}

/** Records one read, off the call path: returns immediately, never throws.
 * Callers must NOT await this on a request path — the unit test asserting
 * sub-50ms return with a hanging insert is the guard. */
export function recordAccess(input: AccessLogInput): void {
  void auditRepo
    .recordAccess({
      accessedBy: input.accessedBy ?? null,
      patientProfileId: input.patientProfileId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      route: input.route ?? null,
      detail: input.detail ?? null,
    })
    .catch((err: unknown) => {
      logFailureCount += 1;
      // Fail-open by design, but loudly: this is a privacy trail, so a
      // silent gap is worse than a noisy one.
      console.error(`[audit] FAILED to record access (${input.entityType} ${input.entityId})`, err);
    });
}

// --- Patient-facing query (PII stripped) ------------------------------------

export interface PatientAccessLogEntry {
  id: string;
  accessedAt: Date;
  entityType: string;
  entityId: string;
  /** The viewer's role only — never their email or internal id. A deleted
   * viewer (FK SetNull) surfaces as the 'deleted_user' placeholder. */
  viewerRole: string;
}

/** Who viewed MY records. The caller supplies only their own
 * patientProfileId (resolved server-side from the authenticated user, never
 * from the request), and the response carries no viewer PII. */
export async function getAccessForPatient(
  patientProfileId: string,
  limit = 100,
): Promise<PatientAccessLogEntry[]> {
  const rows = await auditRepo.findAccessForPatient({ patientProfileId, take: limit });
  return rows.map((row) => ({
    id: row.id,
    accessedAt: row.accessedAt,
    entityType: row.entityType,
    entityId: row.entityId,
    viewerRole: row.accessedByUser?.role ?? 'deleted_user',
  }));
}

// --- Admin queries ----------------------------------------------------------

/** Admin: who accessed a specific kind of record (optionally a specific
 * one). Unlike the patient-facing query this keeps viewer ids — admins
 * need attribution, and role-only would be useless for incident response. */
export function listAccessForEntity(filters: { entityType: string; entityId?: string; limit?: number }) {
  return auditRepo.findAccessByEntity({
    entityType: filters.entityType,
    entityId: filters.entityId,
    take: filters.limit ?? 50,
  });
}

/** Admin: what a specific user accessed. */
export function listAccessForUser(filters: { userId: string; limit?: number }) {
  return auditRepo.findAccessByUser({
    accessedBy: filters.userId,
    take: filters.limit ?? 50,
  });
}

/** Admin: cumulative write-failure count + retention config (alerting). */
export function getAccessLogStats() {
  return { logFailureCount, retentionDays: ACCESS_LOG_RETENTION_DAYS };
}

// --- Retention --------------------------------------------------------------

/** Deletes AccessLog rows older than the retention window. Returns the
 * number of rows removed. Runs from the prune interval in src/server.ts. */
export async function pruneOldAccessLogs(): Promise<number> {
  const cutoff = new Date(Date.now() - ACCESS_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return auditRepo.pruneAccessLogs(cutoff);
}

/** Retention hold (issue #41, docs/adr/0010): AccessLog.patientProfileId
 * cascades, so purging a profile would erase the record of who viewed it.
 * The purge waits until the access log's own retention prune has removed
 * those rows (ACCESS_LOG_RETENTION_DAYS). */
export function hasAccessLogsForPatient(patientProfileId: string): Promise<boolean> {
  // Reuses the existing read rather than adding a repository export: this
  // repository's surface is pinned (tests/integration/audit.test.mts).
  return auditRepo.findAccessForPatient({ patientProfileId, take: 1 }).then((rows) => rows.length > 0);
}
