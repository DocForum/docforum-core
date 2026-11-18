// Consultation auto sign-off sweep (Phase 2, issue #64). A plain interval,
// per ARCHITECTURE_ESSENTIALS.md ("keep jobs simple until a real job exists —
// don't pre-install a queue"). Started from src/server.ts only, so test
// suites that build the app never start a timer. The state change is one
// conditional UPDATE per row inside the consultations module, so running
// more than one process is safe.
import { config } from '../config';
import { runWithRlsBypassContext } from '../db/prisma-client';
import { autoSignOffDueConsultations } from '../modules/consultations/services';

export function startConsultationSignOffJob(): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    // System-initiated, so it runs under the trusted RLS bypass role — there
    // is no request identity to scope the UPDATE to.
    void runWithRlsBypassContext(() => autoSignOffDueConsultations())
      .then(({ signed }) => {
        if (signed > 0) {
          // Count only — never ids or notes.
          // eslint-disable-next-line no-console
          console.log(`[jobs] consultation auto sign-off: ${signed} signed`);
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[jobs] consultation auto sign-off failed: ${err instanceof Error ? err.name : typeof err}`);
      })
      .finally(() => {
        running = false;
      });
  };
  run(); // catch up immediately after a restart, then on the interval
  const timer = setInterval(run, config.consultations.autoSignOffSweepIntervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
