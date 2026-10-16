// audit services — owns AccessLog (PHI read-access logging, issue #45).
// Other modules must only import from here, never from repositories/
// directly. See AGENTS.md "Non-negotiable rules".
//
// The purpose: every read of clinical data (intake, consultation,
// prescription, lab result, order, payment) must leave a record of who
// viewed what and when — this is the "who looked at this" question that
// health-data regimes ask, distinct from AuditEvent's "who changed this".
//
// Design constraints (from issue #45):
// - Written asynchronously off the read path — never blocks the response.
// - Fail-open: a logging failure never fails the read, but IS counted
//   and surfaced for alerting (logFailureCounter + server console.error).
// - p95 read latency target ~300ms (PRD §7) — the insert is fire-and-forget.
import * as auditRepo from '../repositories';

/** Entity types that can be read-logged. Extend as Phase 2/3/4/5 land. */
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

export type RecordAccessInput = {
  /** The viewer's userId. */
  accessedBy?: string | null;
  /** The record owner's patientProfileId (whose data was viewed). */
  patientProfileId?: string | null;
  entityType: AccessEntityType;
  entityId: string;
  /** The HTTP route that returned the payload. */
  route?: string;
  /** Context detail — no PHI, e.g. "GET /appointments/mine". */
  detail?: string;
};

// Failure counter for alerting. Reset manually or via a metrics endpoint
// (not wired to a metrics backend yet — issue #17 provider undecided).
let logFailureCount = 0;

/**
 * Records one read access asynchronously. Returns immediately — the
 * insert is fire-and-forget so it never adds to p95 read latency.
 *
 * Fail-open: if the insert fails, the read still succeeds. The failure
 * is counted and surfaced to the server console for operators.
 */
export function recordAccess(input: RecordAccessInput): void {
  // Fire-and-forget: intentionally not awaited.
  auditRepo
    .recordAccess({
      accessedBy: input.accessedBy ?? null,
      patientProfileId: input.patientProfileId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      route: input.route ?? null,
      detail: input.detail ?? null,
    })
    .catch((err) => {
      logFailureCount += 1;
      // eslint-disable-next-line no-console
      console.error(
        `[audit] FAILED to record access (failure #${logFailureCount}): ` +
          `user=${input.accessedBy ?? 'anon'} target=${input.entityType}/${input.entityId}`,
        err,
      );
    });
}

/** Returns the cumulative count of logging failures (for alerting). */
export function getLogFailureCount(): number {
  return logFailureCount;
}

/** Admin read-side: who accessed a specific entity. */
export async function getAccessByEntity(entityType: string, entityId: string) {
  return auditRepo.findAccessByEntity(entityType, entityId);
}

/** Patient read-side: who viewed MY records. Returns role + id only —
 * never other users' emails or internal PII (per issue #45 review note). */
export async function getAccessForPatient(patientProfileId: string) {
  const rows = await auditRepo.findAccessForPatient(patientProfileId);
  // Strip to what a patient should see: role + relative timestamp + entity.
  // No viewer email, no viewer's other ids.
  return rows.map((r) => ({
    id: r.id,
    accessedAt: r.accessedAt,
    entityType: r.entityType,
    entityId: r.entityId,
    viewerRole: r.accessedByUser?.role ?? 'deleted_user',
  }));
}

/** Admin read-side: what a specific user has accessed. */
export async function getAccessByUser(accessedBy: string) {
  return auditRepo.findAccessByUser(accessedBy);
}

/** Retention: delete rows older than the retention window (days).
 * Default 365 days. Called by the prune interval in server.ts. */
export const ACCESS_LOG_RETENTION_DAYS = Number(process.env.ACCESS_LOG_RETENTION_DAYS ?? 365);

export async function pruneOldAccessLogs(): Promise<number> {
  const cutoff = new Date(Date.now() - ACCESS_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return auditRepo.pruneAccessLogs(cutoff);
}
