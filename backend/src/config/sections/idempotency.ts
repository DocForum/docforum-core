// Idempotent retries (Phase 8, issue #48). Env-configurable so tests can
// use short windows and deployments can tune retention without a code
// change.
export const idempotency = {
  recordTtlHours: Number(process.env.IDEMPOTENCY_RECORD_TTL_HOURS ?? 24),
  inProgressTimeoutSeconds: Number(process.env.IDEMPOTENCY_IN_PROGRESS_TIMEOUT_SECONDS ?? 30),
  maxCachedBodyBytes: Number(process.env.IDEMPOTENCY_MAX_CACHED_BODY_BYTES ?? 1024 * 1024),
} as const;
