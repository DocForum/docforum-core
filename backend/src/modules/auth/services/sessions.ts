// Refresh-session management (Phase 8 #38).
//
// One row per refresh-token family (i.e. per login), referenced by the
// refresh JWT's `sid` claim. This is the revocation store #18 asked for:
// access tokens stay stateless (15-minute TTL, no per-request lookup), but
// a refresh only succeeds while its session row is present and unrevoked —
// which is exactly when revocation has to bite, because that's the
// operation that mints new tokens.
import { HttpError } from '../../../http-error';
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

export function startSession(input: { userId: string } & SessionContext): Promise<{ id: string }> {
  return createRefreshSession(input);
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
    throw new HttpError(401, 'Invalid or expired refresh token.');
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

/** Admin escape hatch: revoke every session for a user (issue #38). */
export async function revokeAllUserSessions(userId: string): Promise<number> {
  const result = await revokeRefreshSessionsForUser({ userId });
  return result.count;
}
