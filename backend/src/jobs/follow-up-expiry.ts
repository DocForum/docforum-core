// Follow-up request expiry sweep (Phase 2, issue #63). A plain interval, per
// ARCHITECTURE_ESSENTIALS.md ("keep jobs simple until a real job exists").
// Started from src/server.ts only, so app-building test suites never start a
// timer. One conditional UPDATE, so more than one process is safe. Expired
// requests stay visible to the patient as `expired`.
import { config } from '../config';
import { expireOpenFollowUps } from '../modules/consultations/services';

export function startFollowUpExpiryJob(): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void expireOpenFollowUps()
      .then(({ expired }) => {
        if (expired > 0) {
          // Count only — never ids or notes.
          // eslint-disable-next-line no-console
          console.log(`[jobs] follow-up expiry: ${expired} expired`);
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[jobs] follow-up expiry failed: ${err instanceof Error ? err.name : typeof err}`);
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  const timer = setInterval(run, config.consultations.followUpExpirySweepIntervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
