// TOTP two-factor authentication (Phase 8, issue #36).
//
// Scope of this file: everything about *a user's enrolment and code checks*.
// It deliberately does not issue sessions — the login/verify sequencing lives
// in services/index.ts, which owns session creation. Other modules never call
// this file directly; the auth service surface re-exports what's needed.
//
// Reviewers' three checks from the issue:
//   • secret storage — encrypted at rest with issue #46's AES-256-GCM field
//     encryption, never logged, never returned after setup;
//   • replay protection — `claimTotpStep` / `consumeRecoveryCode` are single
//     conditional UPDATEs, so a code works once even under concurrency;
//   • half-authenticated tokens — `typ` is checked by `verifyAccessToken`,
//     so an `mfa_pending` token reaches nothing but `/auth/2fa/verify`.
import crypto from 'node:crypto';
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import { encryptField, decryptField } from '../../../utils/field-encryption';
import * as authRepo from '../repositories';
import {
  buildOtpauthUri,
  generateTotpSecret,
  verifyTotp,
} from './totp';

export interface TwoFactorStatus {
  enabled: boolean;
  /** Only meaningful when enabled: how many recovery codes are still unused. */
  unusedRecoveryCodes: number;
}

export interface TwoFactorSetup {
  /** Shown exactly once, so the user can add the account manually. */
  secret: string;
  otpauthUri: string;
}

export interface TwoFactorEnrolment {
  recoveryCodes: string[];
}

/** Normalises a recovery code for hashing/compare: case-insensitive, dashes
 * and spaces ignored, so a user typing it by hand is not punished. */
function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}

/** A 10-character recovery code in `xxxxx-xxxxx` form, from the base32
 * alphabet (no ambiguous 0/1). ~50 bits of entropy, single-use and hashed. */
function generateRecoveryCode(): string {
  const bytes = crypto.randomBytes(10);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let code = '';
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

async function requireUser(userId: string) {
  const user = await authRepo.findUserById(userId);
  if (!user || user.deletedAt) throw new HttpError(401, 'Authentication required.');
  return user;
}

/** The decrypted secret of an *enabled* enrolment. A decryption failure is a
 * server misconfiguration (rotated key), not a client error. */
async function requireEnabledSecret(userId: string): Promise<{ user: Awaited<ReturnType<typeof requireUser>>; secret: string }> {
  const user = await requireUser(userId);
  if (!user.totpEnabledAt || !user.totpSecret) {
    throw new HttpError(409, 'Two-factor authentication is not enabled for this account.', 'TWO_FACTOR_NOT_ENABLED');
  }
  const secret = decryptField(user.totpSecret);
  if (!secret) throw new Error('Two-factor secret could not be decrypted.');
  return { user, secret };
}

export async function getTwoFactorStatus(userId: string): Promise<TwoFactorStatus> {
  const user = await requireUser(userId);
  if (!user.totpEnabledAt) return { enabled: false, unusedRecoveryCodes: 0 };
  return {
    enabled: true,
    unusedRecoveryCodes: await authRepo.countUnusedRecoveryCodes(userId),
  };
}

/**
 * Starts (or restarts) enrolment: mints a fresh secret and stores it
 * encrypted as *pending*. It is not active until `enable` succeeds, and
 * re-running setup before enabling replaces the pending secret (an abandoned
 * QR code must not stay valid).
 *
 * Refuses when 2FA is already enabled: disabling first is the intentional
 * friction, so a stolen access token can't silently re-enrol a second
 * authenticator over the victim's.
 */
export async function startSetup(userId: string): Promise<TwoFactorSetup> {
  const user = await requireUser(userId);
  const account = user.email;
  if (user.totpEnabledAt) {
    throw new HttpError(
      409,
      'Two-factor authentication is already enabled. Disable it with a current code before enrolling again.',
      'TWO_FACTOR_ALREADY_ENABLED',
    );
  }

  const secret = generateTotpSecret();
  const encrypted = encryptField(secret);
  if (!encrypted) throw new Error('Failed to encrypt the two-factor secret.');

  const stored = await authRepo.setPendingTotpSecret(userId, encrypted);
  if (!stored) {
    throw new HttpError(409, 'Two-factor authentication was enabled while setting up. Sign in again.', 'TWO_FACTOR_ALREADY_ENABLED');
  }

  return {
    secret,
    otpauthUri: buildOtpauthUri({ secret, account, issuer: config.twoFactor.issuer }),
  };
}

/**
 * Confirms enrolment with the first real code. On success the secret becomes
 * active and ten single-use recovery codes are generated and returned in
 * plaintext **once** — only their SHA-256 hashes are persisted.
 */
export async function enable(userId: string, code: string): Promise<TwoFactorEnrolment> {
  const user = await requireUser(userId);
  if (user.totpEnabledAt) {
    throw new HttpError(409, 'Two-factor authentication is already enabled.', 'TWO_FACTOR_ALREADY_ENABLED');
  }
  if (!user.totpSecret) {
    throw new HttpError(400, 'Start two-factor setup before confirming it.', 'TWO_FACTOR_SETUP_REQUIRED');
  }
  const secret = decryptField(user.totpSecret);
  if (!secret) throw new Error('Two-factor secret could not be decrypted.');

  const verification = verifyTotp(secret, code);
  if (!verification) throw new HttpError(400, 'Invalid authentication code.', 'INVALID_TOTP_CODE');

  // Claim the step before enabling, so the enrolment code can't immediately
  // be replayed against the very first login.
  if (!(await authRepo.claimTotpStep(userId, verification.step))) {
    throw new HttpError(400, 'This authentication code has already been used.', 'TOTP_CODE_REPLAYED');
  }
  const enabled = await authRepo.enableTotp(userId);
  if (!enabled) throw new HttpError(409, 'Two-factor authentication is already enabled.', 'TWO_FACTOR_ALREADY_ENABLED');

  const recoveryCodes = Array.from({ length: config.twoFactor.recoveryCodeCount }, () => generateRecoveryCode());
  await authRepo.replaceRecoveryCodes(userId, recoveryCodes.map(hashRecoveryCode));
  return { recoveryCodes };
}

/**
 * Checks a code submitted after the password step: a current TOTP code first,
 * then a single-use recovery code. Returns the method used, or a 401. The
 * caller (services/index.ts) only issues a session when this resolves.
 */
export async function verifySecondFactor(userId: string, code: string): Promise<'totp' | 'recovery_code'> {
  const { secret } = await requireEnabledSecret(userId);

  const verification = verifyTotp(secret, code);
  if (verification) {
    if (await authRepo.claimTotpStep(userId, verification.step)) return 'totp';
    throw new HttpError(401, 'This authentication code has already been used.', 'TOTP_CODE_REPLAYED');
  }

  if (await authRepo.consumeRecoveryCode(userId, hashRecoveryCode(code))) {
    return 'recovery_code';
  }

  throw new HttpError(401, 'Invalid authentication code.', 'INVALID_TOTP_CODE');
}

/** Disabling needs a current code or an unused recovery code — possession of
 * the session alone is not enough. Clears the secret and every unused code. */
export async function disable(userId: string, code: string): Promise<void> {
  await requireEnabledSecret(userId);
  await verifySecondFactor(userId, code);
  const disabled = await authRepo.disableTotp(userId, null);
  if (!disabled) {
    throw new HttpError(409, 'Two-factor authentication is not enabled for this account.', 'TWO_FACTOR_NOT_ENABLED');
  }
}
