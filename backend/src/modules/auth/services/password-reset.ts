// Password reset flow (issue #33). Two endpoints, deliberately paired:
//  - request: always behaves the same whether or not the email exists.
//  - confirm: single-use, expiring, hashed token → new password + every
//    outstanding refresh token invalidated.
//
// Security notes enforced here, not just in the controller:
//  - The raw token only ever exists in memory (and in the outbound
//    notification). The DB stores its SHA-256 hash.
//  - Unknown/expired/reused/superseded tokens all produce the *same*
//    generic error, and the hash comparison is constant-time.
//  - Rate-limited per email and per IP before any account lookup.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import { sendPasswordResetLink } from '../../notifications/services';
import { hashPassword } from './password';
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  findPasswordResetTokenByHash,
  findUserByEmail,
} from '../repositories';
import { createRateLimiter } from './rate-limit';

const HOUR_MS = 60 * 60 * 1000;

/** Deliberately 400, not 404/410 — the client must not be able to tell
 * which of "no such token", "expired", "already used" or "superseded by a
 * newer request" happened. */
const GENERIC_INVALID_TOKEN_MESSAGE =
  'This password reset link is invalid or has expired. Request a new one.';

const emailLimiter = createRateLimiter(config.passwordReset.requestsPerEmailPerHour, HOUR_MS);
const ipLimiter = createRateLimiter(config.passwordReset.requestsPerIpPerHour, HOUR_MS);

export function hashResetToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/** Constant-time comparison of two hex-encoded hashes. */
function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface RequestPasswordResetInput {
  email: string;
  /** Coarse source address for the per-IP limit. Never persisted. */
  ip: string;
}

/**
 * Issues a reset token if the email belongs to an account. Always resolves
 * — the caller responds 202 either way, so response *and* status are
 * identical for known and unknown addresses.
 */
export async function requestPasswordReset(input: RequestPasswordResetInput): Promise<void> {
  if (!emailLimiter.consume(input.email.toLowerCase()) || !ipLimiter.consume(input.ip)) {
    throw new HttpError(429, 'Too many password reset requests. Please try again later.');
  }

  const user = await findUserByEmail(input.email);
  if (!user) {
    // Do the same shape of work for an unknown address so timing doesn't
    // leak existence: hash a throwaway token, then drop it.
    hashResetToken(randomBytes(32).toString('base64url'));
    return;
  }

  const rawToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.passwordReset.tokenTtlMinutes * 60_000);

  await createPasswordResetToken({ userId: user.id, tokenHash: hashResetToken(rawToken), expiresAt });
  await sendPasswordResetLink({ email: user.email, token: rawToken, expiresAt, locale: user.locale });
}

export interface ConfirmPasswordResetInput {
  token: string;
  newPassword: string;
}

/** Applies a new password for a valid, unexpired, unused token. */
export async function confirmPasswordReset(input: ConfirmPasswordResetInput): Promise<void> {
  const presentedHash = hashResetToken(input.token);
  const record = await findPasswordResetTokenByHash(presentedHash);

  if (!record || !hashesEqual(record.tokenHash, presentedHash)) {
    throw new HttpError(400, GENERIC_INVALID_TOKEN_MESSAGE);
  }
  if (record.usedAt) throw new HttpError(400, GENERIC_INVALID_TOKEN_MESSAGE);
  if (record.expiresAt.getTime() <= Date.now()) throw new HttpError(400, GENERIC_INVALID_TOKEN_MESSAGE);

  const passwordHash = await hashPassword(input.newPassword);
  const consumed = await consumePasswordResetToken({
    tokenId: record.id,
    userId: record.userId,
    passwordHash,
  });
  // Lost the race to a concurrent confirm of the same token.
  if (!consumed) throw new HttpError(400, GENERIC_INVALID_TOKEN_MESSAGE);
}

/** Test seam only — the limiters are module-level singletons so the limits
 * actually hold across requests. */
export function resetPasswordResetRateLimits(): void {
  emailLimiter.reset();
  ipLimiter.reset();
}
