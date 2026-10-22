// Referral expiry sweep (Phase 3, issue #8). A plain interval, per
// ARCHITECTURE_ESSENTIALS.md ("keep jobs simple until a real job exists —
// don't pre-install a queue"); move it onto a shared job runner if one is
// ever introduced. Started from src/server.ts only, so test suites that build
// the app never start a timer. The state change is one conditional UPDATE in
// the referrals module, so running more than one process is safe.
import { config } from '../config';
import { expireStaleReferrals } from '../modules/referrals/services';

export function startReferralExpiryJob(): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void expireStaleReferrals()
      .then(({ expired }) => {
        if (expired > 0) {
          // Count only — never ids or notes.
          // eslint-disable-next-line no-console
          console.log(`[jobs] referral expiry: ${expired} expired`);
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[jobs] referral expiry failed: ${err instanceof Error ? err.name : typeof err}`);
      })
      .finally(() => {
        running = false;
      });
  };
  run(); // catch up immediately after a restart, then on the interval
  const timer = setInterval(run, config.referrals.expirySweepIntervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
