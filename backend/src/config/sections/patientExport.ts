// Patient data export (Phase 8, issue #40). Env-configurable so a
// deployment can tune retention and memory bounds without a code change.
export const patientExport = {
  // How long a `ready` export stays downloadable before the cleanup job
  // deletes its artifact. Downloads are refused at expiry even if cleanup
  // hasn't run yet.
  ttlHours: Number(process.env.PATIENT_EXPORT_TTL_HOURS ?? 24),
  // Rows fetched per section page while generating — the memory bound on
  // the read side.
  pageSize: Number(process.env.PATIENT_EXPORT_PAGE_SIZE ?? 200),
  // Target size of one stored artifact chunk — the memory bound on the
  // write side and on download (one chunk is in memory at a time).
  chunkBytes: Number(process.env.PATIENT_EXPORT_CHUNK_BYTES ?? 256 * 1024),
  // Worker cadence (src/jobs/patient-exports.ts). A new request also
  // wakes the worker immediately; the interval is the restart/backlog
  // safety net.
  workerIntervalSeconds: Number(process.env.PATIENT_EXPORT_WORKER_INTERVAL_SECONDS ?? 15),
  cleanupIntervalSeconds: Number(process.env.PATIENT_EXPORT_CLEANUP_INTERVAL_SECONDS ?? 5 * 60),
  // A `processing` job whose claim is older than this is presumed dead
  // (process crashed mid-generation) and is retried, up to maxAttempts.
  staleAfterSeconds: Number(process.env.PATIENT_EXPORT_STALE_AFTER_SECONDS ?? 15 * 60),
  maxAttempts: Number(process.env.PATIENT_EXPORT_MAX_ATTEMPTS ?? 3),
} as const;
