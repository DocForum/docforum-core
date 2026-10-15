// Auth services — the only exported surface other modules (and this
// module's own controllers) may call. Never import repositories/* from
// outside this module.
import { HttpError } from '../../../http-error';
import { createSelfServeUser, findUserByEmail, findUserById } from '../repositories';
import { hashPassword, verifyPassword } from './password';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './tokens';
import { redeemAdminInvite } from '../../users/services';
import type { Role } from '@prisma/client';

// Re-exported so middleware/auth.ts (shared infra, not a peer module) can
// verify tokens through this module's service surface rather than
// reaching into services/tokens.ts directly.
export { verifyAccessToken } from './tokens';
export type { AccessTokenPayload } from './tokens';

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

function issueSession(user: { id: string; role: Role }): { accessToken: string; refreshToken: string } {
  const payload = { sub: user.id, role: user.role };
  return { accessToken: signAccessToken(payload), refreshToken: signRefreshToken(payload) };
}

export interface SignupInput {
  role: Extract<Role, 'patient' | 'doctor'>;
  email: string;
  password: string;
  fullName: string;
}

export async function signup(input: SignupInput): Promise<AuthSession> {
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

  const tokens = issueSession(user);
  return { user: toPublicUser(user), ...tokens };
}

export interface LoginInput {
  email: string;
  password: string;
}

export async function login(input: LoginInput): Promise<AuthSession> {
  const user = await findUserByEmail(input.email);
  // Same message whether the email doesn't exist or the password is wrong
  // — don't leak which one it was.
  if (!user) throw new HttpError(401, 'Invalid email or password.');

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) throw new HttpError(401, 'Invalid email or password.');

  // Checked *after* the password: a deactivated account must not be
  // distinguishable from a non-existent one without knowing the password
  // (Phase 8, issue #39).
  if (user.deactivatedAt) {
    throw new HttpError(403, 'This account has been deactivated. Contact an administrator.');
  }

  const tokens = issueSession(user);
  return { user: toPublicUser(user), ...tokens };
}

/**
 * Redeems an admin invite and signs the new admin in (Phase 8, issue #39).
 *
 * The invite itself belongs to the users module — this module only hashes
 * the password and issues the session, calling that module's service rather
 * than its repository (AGENTS.md hard rule 4).
 */
export interface SignupWithInviteInput {
  token: string;
  email: string;
  password: string;
}

export async function signupWithInvite(input: SignupWithInviteInput): Promise<AuthSession> {
  const passwordHash = await hashPassword(input.password);
  const user = await redeemAdminInvite({ token: input.token, email: input.email, passwordHash });

  const tokens = issueSession(user);
  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    ...tokens,
  };
}

export async function refresh(refreshToken: string): Promise<AuthSession> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new HttpError(401, 'Invalid or expired refresh token.');
  }

  const user = await findUserById(payload.sub);
  if (!user) throw new HttpError(401, 'Invalid or expired refresh token.');

  // Deactivated accounts can't refresh out of their deactivation, and a
  // session revoked by deactivation/reactivation can't come back to life
  // through a refresh cookie either (Phase 8, issue #39).
  if (user.deactivatedAt) throw new HttpError(403, 'This account has been deactivated.');
  if (isSessionRevoked(user.sessionsInvalidatedAt, payload.iat)) {
    throw new HttpError(401, 'Your session has been revoked. Please sign in again.');
  }

  const tokens = issueSession(user);
  return { user: toPublicUser(user), ...tokens };
}

/**
 * Guards every authenticated request (Phase 8, issue #39). The access token
 * is otherwise stateless, so a deactivated account's token would keep
 * working for up to 15 minutes; this is the DB read that closes that gap.
 *
 * Deliberately narrow: it answers "is this account still active, and was
 * this token issued after the last deactivation/reactivation", not "is this
 * token on a revocation list" — a general revocation list is issue #18 and
 * is still unbuilt. Because it's a per-request read, tokens carrying no
 * `iat` are treated as revoked once `sessionsInvalidatedAt` is set (fail
 * closed).
 */
export async function assertActiveSession(userId: string, issuedAtSeconds?: number): Promise<void> {
  const user = await findUserById(userId);
  if (!user) throw new HttpError(401, 'Invalid or expired access token.');
  if (user.deactivatedAt) throw new HttpError(401, 'This account has been deactivated.');
  if (isSessionRevoked(user.sessionsInvalidatedAt, issuedAtSeconds)) {
    throw new HttpError(401, 'Your session has been revoked. Please sign in again.');
  }
}

function isSessionRevoked(sessionsInvalidatedAt: Date | null, issuedAtSeconds: number | undefined): boolean {
  if (!sessionsInvalidatedAt) return false;
  // `iat` has second precision, so a token minted in the same second as the
  // invalidation counts as revoked — the safe direction.
  return (issuedAtSeconds ?? 0) * 1000 < sessionsInvalidatedAt.getTime();
}
