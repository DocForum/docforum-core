// Auth-artifact retention (Phase 8, issue #276). A plain interval, per
// ARCHITECTURE_ESSENTIALS.md ("keep jobs simple until a real job exists —
// don't pre-install a queue"). Started from src/server.ts only, so test
// suites that build the app never start a timer.
//
// Five tables grow forever today: EmailVerificationToken,
// PasswordResetToken, AdminInvite, revoked RefreshSession and Sep10Challenge.
// Each pruner deletes at most `AUTH_TOKEN_PRUNE_BATCH_SIZE` rows per
// statement, only rows that are already expired/consumed/revoked past the
// grace period, and is looped up to `AUTH_TOKEN_PRUNE_MAX_BATCHES_PER_RUN`
// times per tick so a backlog drains without holding a long lock.
import { config } from '../config';
import {
  pruneExpiredPasswordResetTokens,
  pruneExpiredVerificationTokens,
  pruneRevokedRefreshSessions,
} from '../modules/auth/services';
import { pruneExpiredAdminInvites } from '../modules/users/services';
import { pruneExpiredSep10Challenges } from '../modules/payments/services';
import { logger } from '../logger';

interface Pruner {
  /** Log label only — never a table dump. */
  name: string;
  run: (options: { now: Date; batchSize: number }) => Promise<number>;
}

const PRUNERS: Pruner[] = [
  { name: 'email-verification tokens', run: pruneExpiredVerificationTokens },
  { name: 'password-reset tokens', run: pruneExpiredPasswordResetTokens },
  { name: 'admin invites', run: pruneExpiredAdminInvites },
  { name: 'revoked refresh sessions', run: pruneRevokedRefreshSessions },
  { name: 'SEP-10 challenges', run: pruneExpiredSep10Challenges },
];

/** Runs one full sweep. Exported for tests and manual invocation. Returns
 * per-table counts (no ids, no values). */
export async function runAuthTokenPrune(now: Date = new Date()): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const pruner of PRUNERS) {
    let deleted = 0;
    for (let batch = 0; batch < config.tokenPrune.maxBatchesPerRun; batch += 1) {
      const removed = await pruner.run({ now, batchSize: config.tokenPrune.batchSize });
      deleted += removed;
      // A short batch means the table is drained (or was already).
      if (removed < config.tokenPrune.batchSize) break;
    }
    counts[pruner.name] = deleted;
  }
  return counts;
}

export function startAuthTokenPruneJob(): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void runAuthTokenPrune()
      .then((counts) => {
        for (const [name, deleted] of Object.entries(counts)) {
          if (deleted > 0) {
            // Counts only — these tables hold hashed credentials/addresses.
            logger.info(`[jobs] auth token prune: removed ${deleted} ${name}`);
          }
        }
      })
      .catch((err) => {
        logger.error(`[jobs] auth token prune failed: ${err instanceof Error ? err.name : typeof err}`);
      })
      .finally(() => {
        running = false;
      });
  };
  run(); // catch up immediately after a restart, then on the interval
  const timer = setInterval(run, config.tokenPrune.intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
