// Auth services — the only exported surface other modules (and this
// module's own controllers) may call. Never import repositories/* from
// outside this module.
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import {
  consumeVerificationToken,
  createSelfServeUser,
  findLatestVerificationToken,
  findUserByEmail,
  findUserById,
  findVerificationTokenByHash,
  markUserEmailVerified,
  replaceVerificationToken,
} from '../repositories';
import { hashPassword, verifyPassword } from './password';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './tokens';
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
import type { Role } from '@prisma/client';
import type { PatientExportSection } from '../../patients/services';

// Re-exported so middleware/auth.ts (shared infra, not a peer module) can
// verify tokens through this module's service surface rather than
// reaching into services/tokens.ts directly.
export { verifyAccessToken } from './tokens';
export type { AccessTokenPayload } from './tokens';

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
}

function toPublicUser(user: {
  id: string;
  email: string;
  role: Role;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function issueSession(user: { id: string; role: Role }): {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
} {
  const payload = { sub: user.id, role: user.role };
  // A fresh CSRF token per session, and per rotation — bound into the
  // refresh token so verifying it needs no server-side state (issue #37).
  const csrfToken = generateCsrfToken();
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken({ ...payload, csrf: csrfToken }),
    csrfToken,
  };
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

  // Phase 8, issue #34: the account is created and usable for browsing
  // immediately, but unverified — mutating routes that depend on a
  // trustworthy contact address are gated by `assertEmailVerified` until
  // the link is redeemed.
  await issueEmailVerification(user);

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

export async function login(input: LoginInput): Promise<AuthSession> {
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
  if (!user || !valid) {
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

  const tokens = issueSession(user);
  return { user: toPublicUser(user), ...tokens };
}

// --- Email verification (Phase 8, issue #34) -----------------------------

/** Mints a fresh token, retires any outstanding one, and hands the link to
 * the email dispatcher. The raw token is never persisted and never logged. */
async function issueEmailVerification(user: { id: string; email: string }): Promise<void> {
  const token = generateVerificationToken();
  const expiresAt = new Date(Date.now() + config.auth.emailVerification.tokenTtlMinutes * 60_000);

  await replaceVerificationToken({ userId: user.id, tokenHash: hashVerificationToken(token), expiresAt });

  const link = `${config.auth.emailVerification.landingUrl}?token=${encodeURIComponent(token)}`;
  try {
    await sendEmail({
      to: user.email,
      subject: 'Verify your DocForum email address',
      text: [
        'Confirm this email address to book appointments and pay for orders:',
        '',
        link,
        '',
        `The link expires in ${Math.round(config.auth.emailVerification.tokenTtlMinutes / 60)} hour(s).`,
      ].join('\n'),
    });
  } catch (err) {
    // A provider hiccup must not fail signup — the account exists and is
    // usable, and the user can hit resend. Logged without the message body.
    // eslint-disable-next-line no-console
    console.error('[auth] verification email dispatch failed:', err instanceof Error ? err.message : err);
  }
}

export interface VerifyEmailResult {
  emailVerifiedAt: Date;
}

export async function verifyEmail(rawToken: string): Promise<VerifyEmailResult> {
  const record = await findVerificationTokenByHash(hashVerificationToken(rawToken));
  if (!record) {
    throw new HttpError(400, 'Invalid email verification token.', 'INVALID_VERIFICATION_TOKEN');
  }
  if (record.consumedAt) {
    throw new HttpError(
      400,
      'This verification link has already been used. Request a new one if your email is still unverified.',
      'INVALID_VERIFICATION_TOKEN',
    );
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(400, 'This verification link has expired. Request a new one.', 'VERIFICATION_TOKEN_EXPIRED');
  }

  const now = new Date();
  // Conditional, not read-then-write — two tabs redeeming the same link
  // must not both report success.
  const consumed = await consumeVerificationToken(record.id, now);
  if (!consumed) {
    throw new HttpError(400, 'This verification link has already been used.', 'INVALID_VERIFICATION_TOKEN');
  }

  const user = await markUserEmailVerified(record.userId, now);
  return { emailVerifiedAt: user.emailVerifiedAt ?? now };
}

export interface ResendVerificationResult {
  resendAfterSeconds: number;
}

/** Rate-limited so an unverified account can't be used to flood an inbox.
 * Account-scoped rather than IP-scoped on purpose, and the endpoint is
 * authenticated, so it can't be used to probe which addresses exist. */
export async function resendVerificationEmail(userId: string): Promise<ResendVerificationResult> {
  const user = await findUserById(userId);
  if (!user) throw new HttpError(401, 'Authentication required.');

  if (user.emailVerifiedAt) {
    throw new HttpError(409, 'This email address is already verified.', 'EMAIL_ALREADY_VERIFIED');
  }

  const intervalSeconds = config.auth.emailVerification.resendIntervalSeconds;
  const latest = await findLatestVerificationToken(userId);
  if (latest) {
    const waitedSeconds = (Date.now() - latest.createdAt.getTime()) / 1000;
    if (waitedSeconds < intervalSeconds) {
      throw new HttpError(
        429,
        `Please wait ${Math.ceil(intervalSeconds - waitedSeconds)}s before requesting another verification email.`,
        'EMAIL_VERIFICATION_RATE_LIMITED',
      );
    }
  }

  await issueEmailVerification(user);
  return { resendAfterSeconds: intervalSeconds };
}

/** The enforcement point for "unverified accounts can log in and browse, but
 * not book or pay" (issue #34). Deliberately a DB read rather than a claim
 * baked into the access token: verifying in another tab then takes effect
 * immediately instead of after the token's 15-minute TTL. */
export async function assertEmailVerified(userId: string): Promise<void> {
  const user = await findUserById(userId);
  if (!user) throw new HttpError(401, 'Authentication required.');
  if (!user.emailVerifiedAt) {
    throw new HttpError(403, 'Verify your email address before continuing.', 'EMAIL_NOT_VERIFIED');
  }
}

/**
 * Exchanges the refresh cookie for a new session.
 *
 * `csrfToken` is the `X-CSRF-Token` header value (Phase 8, issue #37),
 * checked against the claim inside the presented refresh token. The cookie
 * is verified first so a garbage/missing cookie is still a 401, and a
 * *valid* cookie without a matching CSRF token is a 403.
 */
export async function refresh(refreshToken: string, csrfToken?: string | null): Promise<AuthSession> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new HttpError(401, 'Invalid or expired refresh token.');
  }

  if (!payload.csrf || !csrfToken || !csrfTokensMatch(csrfToken, payload.csrf)) {
    throw new HttpError(
      403,
      'Missing or invalid CSRF token. Send the csrfToken from your login response in the X-CSRF-Token header.',
    );
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

/** This module's contribution to the patient data export (issue #40): the
 * login identity itself. Explicit allowlist — never the password hash, and
 * no verification/throttle bookkeeping. */
export const accountExportSection: PatientExportSection = {
  name: 'account',
  version: 1,
  async *pages(subject) {
    const user = await findUserById(subject.userId);
    if (!user) return;
    yield [
      {
        id: user.id,
        email: user.email,
        phone: user.phone,
        role: user.role,
        emailVerifiedAt: user.emailVerifiedAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    ];
  },
};
