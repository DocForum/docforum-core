import { createApp } from './app';
import { config } from './config';
import { pruneLoginAttempts } from './modules/auth/services';
import { pruneOldAccessLogs } from './modules/audit/services';
import { startPatientExportJobs } from './jobs/patient-exports';
import { startEscrowEventPoller } from './jobs/escrow-events';
import { validatePlatformSigners } from './modules/payments/services/platform-signers';
import { verifyPaymentsNetwork } from './modules/payments/services';
import { startAccountPurgeJob } from './jobs/account-purge';
import { startPaymentIntentJobs } from './jobs/payment-intents';

const app = createApp();

async function startServer() {
  await Promise.all([validatePlatformSigners(), verifyPaymentsNetwork()]);
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`docforum-core backend listening on :${config.port}`);
  });
}

void startServer().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[startup] backend startup failed:', error);
  process.exitCode = 1;
});

// Login-throttle cleanup (Phase 8, issue #35). A plain interval, per
// ARCHITECTURE_ESSENTIALS.md ("keep jobs simple until a real job exists —
// don't pre-install a queue"); `unref()` so it never keeps the process
// alive on shutdown. Lives here rather than in app.ts so test suites, which
// only build the app, don't start a timer.
const pruneTimer = setInterval(() => {
  void pruneLoginAttempts()
    .then((removed) => {
      if (removed > 0) {
        // eslint-disable-next-line no-console
        console.log(`[jobs] pruned ${removed} stale login-throttle row(s)`);
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[jobs] login-throttle prune failed:', err);
    });

  // Access-log retention (Phase 8, issue #45): drop rows older than
  // config.accessLog.retentionDays. Same interval as the throttle prune —
  // hourly is far more often than a 365-day window needs, but a second
  // timer for one cheap DELETE is not worth the complexity.
  void pruneOldAccessLogs()
    .then((removed) => {
      if (removed > 0) {
        // eslint-disable-next-line no-console
        console.log(`[jobs] pruned ${removed} expired access-log row(s)`);
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[jobs] access-log prune failed:', err);
    });
}, config.loginThrottle.pruneIntervalSeconds * 1000);
pruneTimer.unref();

// Patient data export worker + expiry cleanup (Phase 8, issue #40).
startPatientExportJobs();
startEscrowEventPoller();
// Deleted-account tombstone purge (Phase 8, issue #41, docs/adr/0010).
startAccountPurgeJob();
// Prepared-transaction expiry (Phase 5.5, issue #80): an unsigned
// create_escrow transaction that outlives its window moves the intent back
// to `created` so the patient can prepare again.
startPaymentIntentJobs();
