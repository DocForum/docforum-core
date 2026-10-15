// Auth services — the only exported surface other modules (and this
// module's own controllers) may call. Never import repositories/* from
// outside this module.
import { HttpError } from '../../../http-error';
import { createSelfServeUser, findUserByEmail, findUserById } from '../repositories';
import { hashPassword, verifyPassword } from './password';
import {
  signAccessToken,
  signMfaPendingToken,
  signRefreshToken,
  verifyMfaPendingToken,
  verifyRefreshToken,
} from './tokens';
import { isTwoFactorEnabled, verifyTwoFactorLogin } from './two-factor';
import { config } from '../../../config';
import type { Role } from '@prisma/client';

// Re-exported so middleware/auth.ts (shared infra, not a peer module) can
// verify tokens through this module's service surface rather than
// reaching into services/tokens.ts directly.
export { verifyAccessToken } from './tokens';
export type { AccessTokenPayload } from './tokens';

// TOTP two-factor auth (Phase 8 #36) — its own file, exposed through this
// module's single service surface.
export {
  disableTwoFactor,
  enableTwoFactor,
  getTwoFactorStatus,
  normalizeRecoveryCode,
  setupTwoFactor,
  type TwoFactorStatus,
} from './two-factor';

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

/** Returned instead of a session when the password step passed but the
 * second factor is still outstanding. Contains a short-lived token that
 * is accepted by exactly one route — POST /auth/2fa/verify. */
export interface MfaRequiredResult {
  mfaRequired: true;
  mfaPendingToken: string;
}

export type LoginResult = AuthSession | MfaRequiredResult;

export async function login(input: LoginInput): Promise<LoginResult> {
  const user = await findUserByEmail(input.email);
  // Same message whether the email doesn't exist or the password is wrong
  // — don't leak which one it was.
  if (!user) throw new HttpError(401, 'Invalid email or password.');

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) throw new HttpError(401, 'Invalid email or password.');

  // Two-step login for enrolled users. The password step deliberately
  // yields no access token at all — an mfa_pending token can't be used
  // anywhere except the verify endpoint (see services/tokens.ts).
  if (await isTwoFactorEnabled(user.id)) {
    return {
      mfaRequired: true,
      mfaPendingToken: signMfaPendingToken({ sub: user.id, role: user.role }),
    };
  }

  // Config flag: admin accounts must have 2FA on to sign in. Checked after
  // the password is verified, so it can't be used to enumerate admin
  // accounts without credentials. NOTE (flagged, not hidden): an admin who
  // has not enrolled yet cannot sign in to enroll while this flag is on —
  // see ARCHITECTURE_ESSENTIALS.md known gaps.
  if (config.twoFactor.requireForAdmin && user.role === 'admin') {
    throw new HttpError(403, 'Two-factor authentication is required for admin accounts. Enable it before signing in.');
  }

  const tokens = issueSession(user);
  return { user: toPublicUser(user), ...tokens };
}

/**
 * Second step of a two-factor login: exchanges an `mfa_pending` token plus
 * a TOTP (or recovery) code for a real session.
 */
export async function completeTwoFactorLogin(input: {
  mfaPendingToken: string;
  code: string;
}): Promise<AuthSession> {
  let payload;
  try {
    payload = verifyMfaPendingToken(input.mfaPendingToken);
  } catch {
    throw new HttpError(401, 'Invalid or expired two-factor session. Sign in again.');
  }

  const user = await findUserById(payload.sub);
  if (!user) throw new HttpError(401, 'Invalid or expired two-factor session. Sign in again.');

  await verifyTwoFactorLogin({ userId: user.id, code: input.code });

  const tokens = issueSession(user);
  return { user: toPublicUser(user), ...tokens };
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

  const tokens = issueSession(user);
  return { user: toPublicUser(user), ...tokens };
}
