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
import type { Role } from '@prisma/client';

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

  // Phase 8, issue #34: the account is created and usable for browsing
  // immediately, but unverified — mutating routes that depend on a
  // trustworthy contact address are gated by `assertEmailVerified` until
  // the link is redeemed.
  await issueEmailVerification(user);

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
