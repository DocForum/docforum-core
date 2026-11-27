// Refresh-session management (Phase 8 #38).
//
// One row per refresh-token family (i.e. per login), referenced by the
// refresh JWT's `sid` claim. This is the revocation store #18 asked for:
// access tokens stay stateless (15-minute TTL, no per-request lookup), but
// a refresh only succeeds while its session row is present and unrevoked —
// which is exactly when revocation has to bite, because that's the
// operation that mints new tokens.
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import { prisma } from '../../../db/prisma-client';
import * as auditService from '../../audit/services';
import type { AuditActor } from '../../audit/services';
import {
  createRefreshSession,
  findRefreshSessionById,
  listRefreshSessions,
  revokeRefreshSession,
  revokeRefreshSessionsForUser,
  touchRefreshSession,
} from '../repositories';

export interface SessionContext {
  /** Coarse, best-effort source address. Never used for authorization. */
  ip?: string;
  userAgent?: string;
}

export interface SessionSummary {
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  userAgent: string | null;
  ip: string | null;
  /** True for the session making this request — the UI's "this device". */
  current: boolean;
}

/** Starts a session, evicting the user's least-recently-used sessions if
 * this login would exceed `MAX_ACTIVE_SESSIONS_PER_USER` (issue #278). The
 * eviction is part of the same transaction as the insert. */
export function startSession(input: { userId: string } & SessionContext): Promise<{ id: string }> {
  return createRefreshSession({ ...input, maxActiveSessions: config.sessions.maxActivePerUser });
}

/**
 * Validates a refresh against its session row. Returns the session id to
 * re-issue against, or throws the same generic 401 the caller uses for any
 * unusable refresh token — a revoked session and a garbage token should be
 * indistinguishable from outside.
 */
export async function assertSessionUsable(input: { sessionId: string; userId: string }): Promise<void> {
  const session = await findRefreshSessionById(input.sessionId);
  if (!session || session.userId !== input.userId || session.revokedAt) {
    throw new HttpError('INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token.');
  }
}

/** Marks the session as used. Called on refresh only. */
export function recordSessionUse(sessionId: string): Promise<unknown> {
  return touchRefreshSession(sessionId);
}

export async function listSessions(input: { userId: string; currentSessionId?: string }): Promise<SessionSummary[]> {
  const sessions = await listRefreshSessions(input.userId);
  return sessions.map((session) => ({
    id: session.id,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    userAgent: session.userAgent,
    ip: session.ip,
    current: session.id === input.currentSessionId,
  }));
}

/**
 * Revokes one of the caller's sessions. `userId` is part of the update's
 * WHERE clause, so another user's session id simply updates nothing — the
 * ownership check is the query, not a branch above it.
 */
export async function revokeSession(input: {
  userId: string;
  sessionId: string;
  currentSessionId?: string;
}): Promise<{ revoked: boolean; wasCurrent: boolean }> {
  const result = await revokeRefreshSession(input.sessionId, input.userId);
  if (result.count !== 1) return { revoked: false, wasCurrent: false };
  // Revoking your own session has to clear the cookie too, otherwise the
  // browser keeps presenting a refresh token whose session is dead.
  return { revoked: true, wasCurrent: input.sessionId === input.currentSessionId };
}

/** "Sign out everywhere else": keeps the caller's own session alive. */
export async function revokeOtherSessions(input: {
  userId: string;
  currentSessionId?: string;
}): Promise<number> {
  const result = await revokeRefreshSessionsForUser({
    userId: input.userId,
    exceptSessionId: input.currentSessionId,
  });
  return result.count;
}

/** Admin escape hatch: revoke every session for a user (issue #38).
 * Writes an AuditEvent in the transaction if any sessions were revoked. */
export async function revokeAllUserSessions(userId: string, actor?: AuditActor): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count > 0 && actor) {
      await auditService.record(tx, actor, {
        entityType: 'User',
        entityId: userId,
        action: 'user.sessions_revoked',
        fromState: null,
        toState: null,
        metadata: { clearedCount: result.count },
      });
    }
    return result.count;
  });
}
