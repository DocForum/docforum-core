// Retention pruning for auth artifacts (Phase 8, issue #276).
//
// Email verification tokens, password reset tokens and revoked refresh
// sessions are deleted once they have been expired/consumed/revoked for
// longer than a configurable grace period. Each call deletes at most
// `AUTH_TOKEN_PRUNE_BATCH_SIZE` rows (the repository does this with
// `DELETE ... WHERE id IN (SELECT ... LIMIT n)`), so a large backlog is
// drained in short statements instead of one long lock. The job in
// src/jobs/auth-token-prune.ts loops the batches.
//
// Every delete is conditional on expiry or consumption: a live token or an
// active (unrevoked) session can never match.
import { config } from '../../../config';
import * as repo from '../repositories';

export interface TokenPruneOptions {
  /** Clock override for tests; defaults to now. */
  now?: Date;
  /** Rows per statement; defaults to AUTH_TOKEN_PRUNE_BATCH_SIZE. */
  batchSize?: number;
}

function batchOptions(options: TokenPruneOptions): { cutoff: Date; batchSize: number } {
  const now = options.now ?? new Date();
  const graceMs = config.tokenPrune.graceHours * 60 * 60 * 1000;
  return {
    cutoff: new Date(now.getTime() - graceMs),
    batchSize: options.batchSize ?? config.tokenPrune.batchSize,
  };
}

/** Deletes expired or consumed verification tokens past the grace period. */
export function pruneExpiredVerificationTokens(options: TokenPruneOptions = {}): Promise<number> {
  return repo.pruneExpiredVerificationTokens(batchOptions(options));
}

/** Deletes expired or used password-reset tokens past the grace period. */
export function pruneExpiredPasswordResetTokens(options: TokenPruneOptions = {}): Promise<number> {
  return repo.pruneExpiredPasswordResetTokens(batchOptions(options));
}

/** Deletes refresh sessions revoked (by logout, an admin, or the #278 cap)
 * more than the grace period ago. Active sessions never match. */
export function pruneRevokedRefreshSessions(options: TokenPruneOptions = {}): Promise<number> {
  return repo.pruneRevokedRefreshSessions(batchOptions(options));
}
