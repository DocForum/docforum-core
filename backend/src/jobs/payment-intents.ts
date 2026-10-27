// Payment-intent jobs (Phase 5.5, issue #80). Plain interval, per
// ARCHITECTURE_ESSENTIALS.md ("keep jobs simple until a real job exists —
// don't pre-install a queue"). Started from src/server.ts only, so test
// suites that build the app never start a timer; tests drive the service
// function directly.
//
// The transition itself is a conditional UPDATE in the payments module
// (`awaiting_signature -> created` only where the prepared window has
// passed), so overlapping runs and multiple processes are safe. Expiry is a
// normal case: the patient simply prepares again.
import { config } from '../config';
import { expireStalePreparedIntents } from '../modules/payments/services';
import { runWithRlsBypassContext } from '../db/prisma-client';

export function startPaymentIntentJobs(): () => void {
  let running = false;
  const sweep = () => {
    if (running) return;
    running = true;
    void runWithRlsBypassContext(() => expireStalePreparedIntents())
      .then(({ expired }) => {
        if (expired > 0) {
          // eslint-disable-next-line no-console
          console.log(`[jobs] expired ${expired} stale prepared payment intent(s)`);
        }
      })
      .catch((err) => {
        // Error type only: a database error message can echo row data.
        // eslint-disable-next-line no-console
        console.error(`[jobs] payment-intent expiry sweep failed: ${err instanceof Error ? err.name : typeof err}`);
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(sweep, config.payments.prepareExpirySweepIntervalSeconds * 1000);
  timer.unref();
  // Pick up anything already past its window on startup.
  sweep();

  return () => clearInterval(timer);
}
