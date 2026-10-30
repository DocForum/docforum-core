// Auth services — the only exported surface other modules (and this
// module's own controllers) may call. Never import repositories/* from
// outside this module.
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import {
  anonymizeUser,
  consumeVerificationToken,
  createSelfServeUser,
  deleteAnonymizedUser,
  deleteLoginAttemptBucket,
  deleteVerificationTokensForUser,
  findLatestVerificationToken,
  findUserByEmail,
  findUserById,
  findVerificationTokenByHash,
  markUserEmailVerified,
  replaceVerificationToken,
  bumpUserTokenVersion,
} from '../repositories';
import { hashPassword, verifyPassword } from './password';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './tokens';
import { assertSessionUsable, recordSessionUse, startSession, type SessionContext } from './sessions';
import { generateVerificationToken, hashVerificationToken } from './verification-tokens';
import { sendEmail } from './email-dispatcher';
import {
  LoginThrottledError,
  checkLoginThrottle,
  emailThrottleKey,
  normalizeClientIp,
  registerFailedLogin,
  resetLoginThrottle,
} from './login-throttle';
import { csrfTokensMatch, generateCsrfToken } from '../../../middleware/csrf';
import { redeemAdminInvite } from '../../users/services';
import type { PatientExportSection } from '../../patients/services';
import type { Locale } from '../../../i18n';
import { formatMessage, resolveLocale } from '../../../i18n';
import { randomBytes } from 'node:crypto';
import type { Prisma, Role } from '@prisma/client';

// Re-exported so middleware/auth.ts (shared infra, not a peer module) can
// verify tokens through this module's service surface rather than
// reaching into services/tokens.ts directly.
export { verifyAccessToken } from './tokens';
export type { AccessTokenPayload } from './tokens';

// Password reset (Phase 8 #33) lives in its own file; re-exported here so
// controllers keep calling a single service surface.
export {
  confirmPasswordReset,
  hashResetToken,
  requestPasswordReset,
  resetPasswordResetRateLimits,
  type ConfirmPasswordResetInput,
  type RequestPasswordResetInput,
} from './password-reset';

// Hashing is auth's business (issue #14): the admin-only facility-creation
// path in the facilities module hashes the initial password through this
// service surface rather than depending on bcrypt directly.
export { hashPassword, verifyPassword } from './password';

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

// Re-exported for the same reason: tests (and, at Phase 6, the provider
// integration) replace the outbound email sender through this module's
// service surface, not by importing the dispatcher file directly.
export { setEmailSender, resetEmailSender } from './email-dispatcher';
export type { EmailMessage, EmailSender } from './email-dispatcher';
// Login throttling (Phase 8, issue #35) — the login controller needs the
// error type to set a `Retry-After` header, and src/server.ts runs the
// cleanup job. Both go through this module's service surface.
export { LoginThrottledError, clearLoginAttempts, pruneLoginAttempts } from './login-throttle';
export type { ThrottleDecision } from './login-throttle';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  locale: string;
  // Phase 8, issue #34 — exposed so docforum-web can gate booking UI on it
  // without a second round trip. The server-side guard is the real
  // enforcement point (`assertEmailVerified`).
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthSession {
  user: AuthenticatedUser;
  accessToken: string;
  refreshToken: string;
  /** Phase 8, issue #37 — handed to the client in the response body so it can
   * echo it back in the `X-CSRF-Token` header on cookie-authenticated routes.
   * It deliberately is NOT a JS-readable cookie: docforum-web is a different
   * site from this API, so it couldn't read one. */
  csrfToken: string;
  /** The refresh-session id this pair belongs to (Phase 8 #38) — lets the
   * client mark its own entry in `GET /auth/sessions` as "this device". */
  sessionId: string;
}

function toPublicUser(user: {
  id: string;
  email: string;
  role: Role;
  locale?: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    locale: user.locale ?? 'en',
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function issueTokensForSession(
  user: { id: string; role: Role; tokenVersion?: number; locale?: string },
  sessionId: string,
): { accessToken: string; refreshToken: string; csrfToken: string } {
  const payload = { sub: user.id, role: user.role, tv: user.tokenVersion ?? 0, locale: user.locale ?? 'en' };
  // A fresh CSRF token per session, and per rotation — bound into the
  // refresh token so verifying it needs no server-side state (issue #37).
  const csrfToken = generateCsrfToken();
  // `sid` rides on the refresh token only: access tokens stay stateless so
  // no protected request needs a session lookup (issue #38's "no write
  // hot-spot" requirement).
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken({ ...payload, csrf: csrfToken, sid: sessionId }),
    csrfToken,
  };
}

/** Starts a new session (one per login) and issues its first token pair. */
async function issueNewSession(
  user: { id: string; role: Role; tokenVersion?: number; locale?: string },
  context: SessionContext,
): Promise<{ accessToken: string; refreshToken: string; csrfToken: string; sessionId: string }> {
  const session = await startSession({ userId: user.id, ...context });
  return { ...issueTokensForSession(user, session.id), sessionId: session.id };
}

export interface SignupInput {
  role: Extract<Role, 'patient' | 'doctor'>;
  email: string;
  password: string;
  fullName: string;
  locale?: Locale;
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
    locale: input.locale,
  });

  // Phase 8, issue #34: the account is created and usable for browsing
  // immediately, but unverified — mutating routes that depend on a
  // trustworthy contact address are gated by `assertEmailVerified` until
  // the link is redeemed.
  await issueEmailVerification(user);

  const tokens = await issueNewSession(user, context);
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

export async function signupWithInvite(input: SignupWithInviteInput, context: SessionContext = {}): Promise<AuthSession> {
  const passwordHash = await hashPassword(input.password);
  const user = await redeemAdminInvite({ token: input.token, email: input.email, passwordHash });

  const tokens = await issueNewSession(user, context);
  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      locale: user.locale,
      // No verification email is sent on the invite path — the invite itself
      // is the admin-vetted proof of address, so this stays null rather than
      // claiming a verification that never happened.
      emailVerifiedAt: null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    ...tokens,
  };
}

export interface LoginInput {
  email: string;
  password: string;
  /** Client IP as Express resolved it (see TRUST_PROXY in config). Optional
   * so non-HTTP callers/tests can omit it — the IP bucket is then simply
   * not tracked for that attempt. */
  ip?: string | null;
}

/** A real bcrypt hash (of a random string nobody knows) that a login for a
 * non-existent address is compared against. Without it, an unknown email
 * returns in ~0ms while a known one spends ~300ms in bcrypt — a timing
 * side channel that answers "does this account exist?" even though the
 * response body is identical. */
const ABSENT_ACCOUNT_HASH = '$2b$12$z8J5gwFm9TiwC.YpeD6yguMkgakFPA8egT1KEKYiaeVkmb3CHRGXu';

export async function login(input: LoginInput, context: SessionContext = {}): Promise<AuthSession> {
  const throttleKeys = {
    emailKey: emailThrottleKey(input.email),
    ipKey: normalizeClientIp(input.ip),
  };

  // Before the password is even looked at: a locked or backing-off bucket is
  // refused identically for a real and a non-existent address (issue #35).
  const gate = await checkLoginThrottle(throttleKeys);
  if (gate.blocked) {
    // Still counted: backoff starts below the lock threshold, so if gated
    // attempts weren't recorded the lock could never be reached. These are
    // failed attempts either way (no credential was accepted).
    const afterFailure = await registerFailedLogin(throttleKeys);
    throw new LoginThrottledError(Math.max(gate.retryAfterSeconds, afterFailure.retryAfterSeconds));
  }

  const user = await findUserByEmail(input.email);
  // Same message whether the email doesn't exist or the password is wrong —
  // and the same *cost*, hence the dummy comparison for an absent account.
  const valid = await verifyPassword(input.password, user?.passwordHash ?? ABSENT_ACCOUNT_HASH);
  // `deletedAt` (issue #41): a deleted account's password is already
  // unusable and its address is a tombstone, so this is defence in depth —
  // and it answers exactly like a wrong password.
  if (!user || !valid || user.deletedAt) {
    const afterFailure = await registerFailedLogin(throttleKeys);
    if (afterFailure.blocked) throw new LoginThrottledError(afterFailure.retryAfterSeconds);
    throw new HttpError(401, 'Invalid email or password.');
  }

  await resetLoginThrottle(throttleKeys.emailKey);

  // Checked *after* the password: a deactivated account must not be
  // distinguishable from a non-existent one without knowing the password
  // (Phase 8, issue #39).
  if (user.deactivatedAt) {
    throw new HttpError(403, 'This account has been deactivated. Contact an administrator.');
  }

  const tokens = await issueNewSession(user, context);
  return { user: toPublicUser(user), ...tokens };
}

// --- Email verification (Phase 8, issue #34) -----------------------------

/** Mints a fresh token, retires any outstanding one, and hands the link to
 * the email dispatcher. The raw token is never persisted and never logged. */
async function issueEmailVerification(user: { id: string; email: string; locale?: string }): Promise<void> {
  const token = generateVerificationToken();
  const expiresAt = new Date(Date.now() + config.auth.emailVerification.tokenTtlMinutes * 60_000);

  await replaceVerificationToken({ userId: user.id, tokenHash: hashVerificationToken(token), expiresAt });
}
