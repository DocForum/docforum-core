import { createApp } from './app';
import { config } from './config';
import { logger } from './logger';
import { pruneLoginAttempts } from './modules/auth/services';
import { pruneIdempotencyKeys } from './middleware/idempotency';
import { pruneOldAccessLogs } from './modules/audit/services';
import { startPatientExportJobs } from './jobs/patient-exports';
import { startEscrowEventPoller } from './jobs/escrow-events';
import { validatePlatformSigners } from './modules/payments/services/platform-signers';
import { startOutboxEventJobs } from './jobs/outbox-events';
import { startLabResultEscalationJobs } from './jobs/lab-result-escalation';
import { validateSep10Config, validateWalletLinkConfig, verifyPaymentsNetwork } from './modules/payments/services';
import { startAccountPurgeJob } from './jobs/account-purge';
import { startPaymentIntentJobs } from './jobs/payment-intents';
import { startReferralExpiryJob } from './jobs/referral-expiry';
import { startOrderExpiryJob } from './jobs/order-expiry';
import { startFollowUpExpiryJob } from './jobs/follow-up-expiry';
import { startConsultationSignOffJob } from './jobs/consultation-sign-off';
import { startAuthTokenPruneJob } from './jobs/auth-token-prune';
import { expireUnfulfilledOrders } from './jobs/lab-order-expiry';
import { prisma } from './db/prisma-client';
import { startNotificationFanout } from './modules/notifications/services';

const app = createApp();

let server: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;

// Patient data export worker + expiry cleanup (Phase 8, issue #40).
const stopPatientExports = startPatientExportJobs();
const stopEscrowEventPoller = startEscrowEventPoller();
// Deleted-account tombstone purge (Phase 8, issue #41, docs/adr/0010).
const stopAccountPurge = startAccountPurgeJob();
// Prepared-transaction expiry (Phase 5.5, issue #80): an unsigned
// create_escrow transaction that outlives its window moves the intent back
// to `created` so the patient can prepare again.
const stopPaymentIntentJobs = startPaymentIntentJobs();
// Referral expiry (Phase 3, issue #8): pending referrals nobody acted on
// within REFERRAL_PENDING_TTL_DAYS become `expired`.
const stopReferralExpiry = startReferralExpiryJob();
// Unconfirmed order expiry job (auto-confirm when window elapses with no dispute).
const stopOrderExpiry = startOrderExpiryJob();
// Follow-up requests unbooked past their window (Phase 2, issue #63).
const stopFollowUpExpiry = startFollowUpExpiryJob();
// Notes unsigned after the grace period (Phase 2, issue #64).
const stopConsultationSignOff = startConsultationSignOffJob();
// Expired/consumed auth tokens, revoked sessions and stale SEP-10
// challenges, in bounded batches (Phase 8, issue #276).
const stopAuthTokenPrune = startAuthTokenPruneJob();
// Cross-instance real-time notification fan-out (Phase 6, issue #330): a
// dedicated Postgres LISTEN connection, reconnected on loss.
const stopNotificationFanout = startNotificationFanout();

// Startup logging via the structured logger (Phase 9, issue #341)
logger.info('backend startup starting');

async function startServer() {
  await Promise.all([validatePlatformSigners(), verifyPaymentsNetwork(), validateSep10Config()]);
  validateWalletLinkConfig();
  if (shuttingDown) return;
  server = app.listen(config.port, () => {
    logger.info(`docforum-core backend listening on :${config.port}`);
  });
}

void startServer().catch((_error: unknown) => {
  process.exitCode = 1;
});

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
   logger.info(`[shutdown] ${signal} received; draining HTTP requests`);
  clearInterval(pruneTimer);
  clearInterval(orderExpiryTimer);
  stopPatientExports();
  stopEscrowEventPoller();
  stopAccountPurge();
  stopPaymentIntentJobs();
  stopReferralExpiry();
  stopOrderExpiry();
  stopFollowUpExpiry();
  stopConsultationSignOff();
  stopAuthTokenPrune();
  await stopNotificationFanout();
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
        logger.info(`[jobs] pruned ${removed} stale login-throttle row(s)`);
      }
    })
    .catch((_err) => {
      // Errors are logged elsewhere; suppress here to avoid double-logging.
    });

  // Access-log retention (Phase 8, issue #45): drop rows older than
  // config.accessLog.retentionDays. Same interval as the throttle prune —
  // hourly is far more often than a 365-day window needs, but a second
  // timer for one cheap DELETE is not worth the complexity.
  void pruneOldAccessLogs()
    .then((removed) => {
      if (removed > 0) {
        logger.info(`[jobs] pruned ${removed} expired access-log row(s)`);
      }
    })
    .catch((_err) => {
      // Errors are logged elsewhere; suppress here to avoid double-logging.
    });

  // Idempotency-key retention (Phase 8, issue #48): drop rows whose TTL has
  // passed. Correctness does not depend on it, but pruning keeps the table
  // bounded.
  void pruneIdempotencyKeys()
    .then((removed) => {
      if (removed > 0) {
        logger.info(`[jobs] pruned ${removed} expired idempotency-key row(s)`);
      }
    })
    .catch((_err) => {
      // Errors are logged elsewhere; suppress here to avoid double-logging.
    });
}, config.loginThrottle.pruneIntervalSeconds * 1000);
pruneTimer.unref();

// Patient data export worker + expiry cleanup (Phase 8, issue #40).
startPatientExportJobs();
startEscrowEventPoller();
startOutboxEventJobs();
// Abnormal lab result escalation (Phase 4, issue #72): an unacknowledged
// abnormal/critical result moves to the admin queue once its deadline passes.
startLabResultEscalationJobs();
// Deleted-account tombstone purge (Phase 8, issue #41, docs/adr/0010).
startAccountPurgeJob();
// Prepared-transaction expiry (Phase 5.5, issue #80): an unsigned
// create_escrow transaction that outlives its window moves the intent back
// to `created` so the patient can prepare again.
startPaymentIntentJobs();
// Referral expiry (Phase 3, issue #8): pending referrals nobody acted on
// within REFERRAL_PENDING_TTL_DAYS become `expired`.
startReferralExpiryJob();
// Unconfirmed order expiry job (auto-confirm when window elapses with no dispute).
startOrderExpiryJob();

// Lab orders still unfulfilled past their expiresAt move to `expired`.
const orderExpiryTimer = setInterval(() => { void expireUnfulfilledOrders().catch((_err) => {
      // Errors are logged elsewhere; suppress here to avoid double-logging.
    }); }, 60 * 60 * 1000);
orderExpiryTimer.unref();
