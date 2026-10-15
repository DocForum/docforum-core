// Auth services — the only exported surface other modules (and this
// module's own controllers) may call. Never import repositories/* from
// outside this module.
import { HttpError } from '../../../http-error';
import { createSelfServeUser, findUserByEmail, findUserById } from '../repositories';
import { hashPassword, verifyPassword } from './password';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './tokens';
import { assertSessionUsable, recordSessionUse, startSession, type SessionContext } from './sessions';
import type { Role } from '@prisma/client';

// Re-exported so middleware/auth.ts (shared infra, not a peer module) can
// verify tokens through this module's service surface rather than
// reaching into services/tokens.ts directly.
export { verifyAccessToken } from './tokens';
export type { AccessTokenPayload } from './tokens';

export {
  assertSessionUsable,
  listSessions,
  recordSessionUse,
  revokeAllUserSessions,
  revokeOtherSessions,
  revokeSession,
  startSession,
  type SessionContext,
  type SessionSummary,
} from './sessions';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthSession {
  user: AuthenticatedUser;
  accessToken: string;
  refreshToken: string;
  /** The refresh-session id this pair belongs to (Phase 8 #38) — lets the
   * client mark its own entry in `GET /auth/sessions` as "this device". */
  sessionId: string;
}

function toPublicUser(user: {
  id: string;
  email: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}): AuthenticatedUser {
  return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt, updatedAt: user.updatedAt };
}

function issueTokensForSession(
  user: { id: string; role: Role },
  sessionId: string,
): { accessToken: string; refreshToken: string } {
  // `sid` rides on the refresh token only: access tokens stay stateless so
  // no protected request needs a session lookup (issue #38's "no write
  // hot-spot" requirement).
  return {
    accessToken: signAccessToken({ sub: user.id, role: user.role }),
    refreshToken: signRefreshToken({ sub: user.id, role: user.role, sid: sessionId }),
  };
}

/** Starts a new session (one per login) and issues its first token pair. */
async function issueNewSession(
  user: { id: string; role: Role },
  context: SessionContext,
): Promise<{ accessToken: string; refreshToken: string; sessionId: string }> {
  const session = await startSession({ userId: user.id, ...context });
  return { ...issueTokensForSession(user, session.id), sessionId: session.id };
}

export interface SignupInput {
  role: Extract<Role, 'patient' | 'doctor'>;
  email: string;
  password: string;
  fullName: string;
}

export async function signup(input: SignupInput, context: SessionContext = {}): Promise<AuthSession> {
  // Facility accounts are admin-invited only (PRD OQ-2) — enforced here,
  // not just in docforum-web's UI. `Extract<Role, 'patient'|'doctor'>` on
  // the type already narrows this at compile time; this is the runtime
  // guard for a request that bypasses the frontend entirely.
  if (input.role !== 'patient' && input.role !== 'doctor') {
    throw new HttpError(400, 'Self-serve signup is only available for patient or doctor accounts.');
  }

  const existing = await findUserByEmail(input.email);
  if (existing) {
    throw new HttpError(409, 'An account with this email already exists.');
  }

  const passwordHash = await hashPassword(input.password);
  const user = await createSelfServeUser({
    email: input.email,
    passwordHash,
    role: input.role,
    fullName: input.fullName,
  });

  const tokens = await issueNewSession(user, context);
  return { user: toPublicUser(user), ...tokens };
}

export interface LoginInput {
  email: string;
  password: string;
}

export async function login(input: LoginInput, context: SessionContext = {}): Promise<AuthSession> {
  const user = await findUserByEmail(input.email);
  // Same message whether the email doesn't exist or the password is wrong
  // — don't leak which one it was.
  if (!user) throw new HttpError(401, 'Invalid email or password.');

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) throw new HttpError(401, 'Invalid email or password.');

  const tokens = await issueNewSession(user, context);
  return { user: toPublicUser(user), ...tokens };
}

/**
 * Exchanges a refresh cookie for a new pair. The refresh token's `sid` is
 * checked against its `RefreshSession` row, so a revoked session stops
 * working here — immediately, on the next refresh.
 */
export async function refresh(refreshToken: string): Promise<AuthSession> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new HttpError(401, 'Invalid or expired refresh token.');
  }

  const user = await findUserById(payload.sub);
  if (!user) throw new HttpError(401, 'Invalid or expired refresh token.');

  // Tokens minted before session records existed carry no `sid` and are
  // rejected: the migration logs existing sessions out once, which is the
  // honest trade for actually having a revocation store.
  if (!payload.sid) throw new HttpError(401, 'Invalid or expired refresh token.');

  await assertSessionUsable({ sessionId: payload.sid, userId: user.id });
  await recordSessionUse(payload.sid);

  // Rotation keeps the same session (same family, same `sid`) — a new
  // session row per refresh would make "list my sessions" useless.
  const tokens = issueTokensForSession(user, payload.sid);
  return { user: toPublicUser(user), ...tokens, sessionId: payload.sid };
}

/** The session id behind a refresh cookie, for endpoints that need to know
 * which of the caller's sessions is the current one. Returns undefined for
 * a missing/unverifiable cookie rather than throwing — "which session am
 * I" is never the reason a request should fail. */
export function sessionIdFromRefreshToken(refreshToken: string | undefined): string | undefined {
  if (!refreshToken) return undefined;
  try {
    return verifyRefreshToken(refreshToken).sid;
  } catch {
    return undefined;
  }
}
