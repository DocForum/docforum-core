// Retention-pruning knobs (Phase 8, issue #276). Deletes only rows that are
// already expired, consumed or revoked — the grace period keeps them long
// enough to investigate a support report without letting the tables grow
// forever.
const graceHours = Number(process.env.AUTH_TOKEN_PRUNE_GRACE_HOURS ?? 24);
const batchSize = Number(process.env.AUTH_TOKEN_PRUNE_BATCH_SIZE ?? 500);
const maxBatchesPerRun = Number(process.env.AUTH_TOKEN_PRUNE_MAX_BATCHES_PER_RUN ?? 20);
const intervalSeconds = Number(process.env.AUTH_TOKEN_PRUNE_INTERVAL_SECONDS ?? 3600);

function positiveInt(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const tokenPrune = {
  graceHours: Number.isFinite(graceHours) && graceHours >= 0 ? graceHours : 24,
  batchSize: positiveInt(batchSize, 500),
  maxBatchesPerRun: positiveInt(maxBatchesPerRun, 20),
  intervalSeconds: positiveInt(intervalSeconds, 3600),
} as const;
