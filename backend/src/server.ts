import { createApp } from './app';
import { config } from './config';
import { pruneLoginAttempts } from './modules/auth/services';
import { startPatientExportJobs } from './jobs/patient-exports';

const app = createApp();

// Fail fast on a missing/invalid SEP-10 web-auth configuration (issue
// #77): a typo'd signing secret should stop boot, not surface as a 500
// on the first challenge request. Reports env var NAMES only — never a
// secret value. Placed here (not at config import) so test suites, which
// only build the app, aren't forced to boot with payments configured.
async function start(): Promise<void> {
  await validateSep10Config();
  // Issue #78: a malformed WALLET_LINK_UNVERIFIED_FUNDING_CUTOFF must
  // stop boot too — naming the env var, never a value.
  validateWalletLinkConfig();
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`docforum-core backend listening on :${config.port}`);
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
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
}, config.loginThrottle.pruneIntervalSeconds * 1000);
pruneTimer.unref();

// Patient data export worker + expiry cleanup (Phase 8, issue #40).
startPatientExportJobs();
