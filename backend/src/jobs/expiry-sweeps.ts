// Shared bounded-loop mechanics for the order-expiry sweeps (issue #348).
//
// The loop holds at most one batch of rows in memory. `after` is a keyset
// cursor (id for the unconfirmed-order sweep, {expiresAt, id} for the lab
// sweep), so a run that stops at the cap resumes cleanly on the next
// scheduled tick: eligible rows left behind are simply picked up later.
// No row is deleted or rewritten outside the sweeps' existing conditional
// status transitions.

export interface SweepLogger {
  /** Structured fields only: counts and job labels, never ids or PII. */
  info: (fields: Record<string, unknown>, message?: string) => void;
}

export interface BatchedSweepResult {
  selected: number;
  expired: number;
  skipped: number;
  batches: number;
  capHit: boolean;
}

export interface BatchedSweepArgs<T, C> {
  /** Log label only. */
  job: string;
  batchSize: number;
  maxPerRun: number;
  /** Select only rows strictly after `after`, at most `limit` of them. */
  selectBatch: (after: C | null, limit: number) => Promise<T[]>;
  /** Derive the next cursor from the last row of the batch. */
  cursorFrom: (row: T) => C;
  processBatch: (rows: T[], batchNumber: number) => Promise<{ expired: number; skipped: number }>;
  logger?: SweepLogger;
}

/**
 * Runs a bounded keyset sweep. One batch is selected, processed, then logged;
 * the cursor advances past that batch before the next select. A short/empty
 * batch ends the run; reaching `maxPerRun` ends it with `capHit: true` so the
 * caller can say plainly that work remains for the next scheduled run.
 */
export async function runBatchedSweep<T, C>(args: BatchedSweepArgs<T, C>): Promise<BatchedSweepResult> {
  const { job, batchSize, maxPerRun, selectBatch, cursorFrom, processBatch, logger } = args;
  let after: C | null = null;
  let selected = 0;
  let expired = 0;
  let skipped = 0;
  let batches = 0;
  let capHit = false;

  while (selected < maxPerRun) {
    const limit = Math.min(batchSize, maxPerRun - selected);
    const rows = await selectBatch(after, limit);
    if (rows.length === 0) break;

    after = cursorFrom(rows[rows.length - 1]);
    const counts = await processBatch(rows, batches + 1);
    batches += 1;
    selected += rows.length;
    expired += counts.expired;
    skipped += counts.skipped;

    logger?.info(
      {
        job,
        batch: batches,
        selected: rows.length,
        expired: counts.expired,
        skipped: counts.skipped,
        capHit: false,
      },
      'expiry sweep batch',
    );

    if (rows.length < limit) break;
    if (selected >= maxPerRun) {
      capHit = true;
      break;
    }
  }

  logger?.info({ job, selected, expired, skipped, batches, capHit }, 'expiry sweep complete');
  return { selected, expired, skipped, batches, capHit };
}
