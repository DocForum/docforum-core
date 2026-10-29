// Deleted-account tombstone purge (Phase 8, issue #41, docs/adr/0010). A
// plain interval, per ARCHITECTURE_ESSENTIALS.md ("keep jobs simple until a
// real job exists — don't pre-install a queue"); move it onto a shared job
// runner if one is ever introduced. Started from src/server.ts only, so test
// suites that build the app never start a timer.
import { config } from '../config';
import { purgeDeletedPatientAccounts } from '../modules/patients/services';
import { runWithRlsBypassContext } from '../db/prisma-client';

export function startAccountPurgeJob(): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void runWithRlsBypassContext(() => purgeDeletedPatientAccounts())
      .then(({ purged, held, failed }) => {
        if (purged > 0 || failed > 0) {
          // Counts only — never ids or personal fields.
          // eslint-disable-next-line no-console
          console.log(`[jobs] account purge: ${purged} purged, ${held} retained (records), ${failed} failed`);
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[jobs] account purge failed: ${err instanceof Error ? err.name : typeof err}`);
      })
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(run, config.accountPurge.intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
