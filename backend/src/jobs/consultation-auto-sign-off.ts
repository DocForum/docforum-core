// Auto sign-off of stale consultation drafts (issue #64).
//
// A plain interval, deliberately — ARCHITECTURE.md §6.3.2 / §2 flag a real
// queue (BullMQ/Redis) as premature until a job actually needs one. This
// job is a periodic `UPDATE ... WHERE signedAt IS NULL AND createdAt <=
// cutoff`, which an interval handles fine.
//
// Started from src/server.ts (not from app.ts, so importing the app in a
// test never starts a timer).
import { config } from '../config';
import { autoSignOffDueConsultations } from '../modules/consultations/services';

/** Runs one pass. Called by the interval, and directly by tests. */
export async function runConsultationAutoSignOff(now: Date = new Date()): Promise<number> {
  const signedOff = await autoSignOffDueConsultations(now);
  if (signedOff > 0) {
    // eslint-disable-next-line no-console
    console.log(`[jobs] auto-signed off ${signedOff} consultation(s) past the edit window`);
  }
  return signedOff;
}

export function startConsultationAutoSignOffJob(): NodeJS.Timeout {
  const intervalMs = config.consultations.autoSignoffCheckIntervalMinutes * 60_000;

  const timer = setInterval(() => {
    // Never let a job failure take the process down with it.
    void runConsultationAutoSignOff().catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[jobs] consultation auto sign-off failed', error);
    });
  }, intervalMs);

  // Don't keep the process alive just for this timer.
  timer.unref();
  return timer;
}
