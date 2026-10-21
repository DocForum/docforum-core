import { createApp } from './app';
import { config } from './config';
import { pruneLoginAttempts } from './modules/auth/services';
import { pruneOldAccessLogs } from './modules/audit/services';
import { startPatientExportJobs } from './jobs/patient-exports';
import { startEscrowEventPoller } from './jobs/escrow-events';
import { validatePlatformSigners } from './modules/payments/services/platform-signers';
import { verifyPaymentsNetwork } from './modules/payments/services';
import { prisma } from './db/prisma-client';


const app = createApp();

let server: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;
const stopPatientExports = startPatientExportJobs();
const stopEscrowEventPoller = startEscrowEventPoller();

async function startServer() {
  await Promise.all([validatePlatformSigners(), verifyPaymentsNetwork()]);
  if (shuttingDown) return;
  server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`docforum-core backend listening on :${config.port}`);
  });
}

void startServer().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[startup] backend startup failed:', error);
  process.exitCode = 1;
});

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[shutdown] ${signal} received; draining HTTP requests`);
  clearInterval(pruneTimer);
  stopPatientExports();
  stopEscrowEventPoller();
  if (server) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => server?.closeAllConnections(), 10_000);
      server!.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  await prisma.$disconnect();
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

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
