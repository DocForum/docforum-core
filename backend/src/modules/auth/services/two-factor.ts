// TOTP two-factor authentication (Phase 8 #36). See:
//  - services/totp.ts        — the RFC 6238 algorithm itself
//  - services/secret-crypto.ts — encryption at rest for the shared secret
//
// Everything security-relevant lives here rather than in the controller:
// replay protection, single-use recovery codes, the "already enrolled"
// guard, and the disable rules.
import { randomBytes } from 'node:crypto';
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import { hashPassword, verifyPassword } from './password';
import { buildOtpauthUri, generateTotpSecret, verifyTotpCode } from './totp';
import { decryptSecret, encryptSecret } from './secret-crypto';
import {
  confirmTwoFactorEnablement,
  deleteTwoFactor,
  findTwoFactorByUserId,
  findUserById,
  markRecoveryCodeUsed,
  recordTotpTimeStep,
  upsertTwoFactorEnrollment,
} from '../repositories';

const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no I/L/O/0/1 — read-aloud safe

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: Date | null;
  /** True once a secret has been issued but not yet confirmed. */
  pendingEnrollment: boolean;
}

export async function getTwoFactorStatus(userId: string): Promise<TwoFactorStatus> {
  const record = await findTwoFactorByUserId(userId);
  return {
    enabled: record?.enabledAt != null,
    enabledAt: record?.enabledAt ?? null,
    pendingEnrollment: record != null && record.enabledAt == null,
  };
}

export async function isTwoFactorEnabled(userId: string): Promise<boolean> {
  const record = await findTwoFactorByUserId(userId);
  return record?.enabledAt != null;
}

/**
 * Starts enrollment: generates a secret, stores it encrypted, and returns
 * the `otpauth://` URI for the authenticator app. Nothing is enforceable
 * until `enableTwoFactor` confirms a first code, so a lost/abandoned
 * enrollment never locks anyone out.
 */
export async function setupTwoFactor(input: { userId: string }): Promise<{ otpauthUri: string }> {
  const existing = await findTwoFactorByUserId(input.userId);
  if (existing?.enabledAt) {
    throw new HttpError(409, 'Two-factor authentication is already enabled for this account.');
  }

  const user = await findUserById(input.userId);
  if (!user) throw new HttpError(401, 'Authentication required.');

  const secretBase32 = generateTotpSecret();
  await upsertTwoFactorEnrollment({ userId: input.userId, secretEncrypted: encryptSecret(secretBase32) });

  return {
    otpauthUri: buildOtpauthUri({
      secretBase32,
      // The authenticator's own entry label — the email is what the user
      // recognizes, and it never leaves this server except in the URI the
      // user themselves requested.
      label: user.email,
      issuer: config.twoFactor.issuer,
    }),
  };
}

/**
 * Confirms enrollment with a first code and issues the recovery codes.
 * The plaintext codes are returned exactly once — only bcrypt hashes are
 * stored, same as passwords.
 */
export async function enableTwoFactor(input: { userId: string; code: string }): Promise<{ recoveryCodes: string[] }> {
  const record = await findTwoFactorByUserId(input.userId);
  if (!record) throw new HttpError(400, 'Start two-factor setup before enabling it.');
  if (record.enabledAt) throw new HttpError(409, 'Two-factor authentication is already enabled for this account.');

  const secretBase32 = decryptSecret(record.secretEncrypted);
  // No replay check here: enrollment is a one-shot transition, and the
  // first code the authenticator shows is legitimately the current step.
  if (!verifyTotpCode({ secretBase32, code: input.code }).valid) {
    throw new HttpError(401, 'That code is not valid. Check your authenticator app and try again.');
  }

  const recoveryCodes = Array.from({ length: config.twoFactor.recoveryCodeCount }, generateRecoveryCode);
  const recoveryCodeHashes = await Promise.all(recoveryCodes.map((code) => hashPassword(code)));

  await confirmTwoFactorEnablement({
    twoFactorId: record.id,
    recoveryCodeHashes,
    enabledAt: new Date(),
  });

  return { recoveryCodes };
}

/**
 * Second step of login: a TOTP code (or a single-use recovery code).
 * Records the consumed time step so the same code can't be replayed in its
 * own window.
 */
export async function verifyTwoFactorLogin(input: { userId: string; code: string }): Promise<void> {
  const record = await findTwoFactorByUserId(input.userId);
  if (!record?.enabledAt) {
    throw new HttpError(400, 'Two-factor authentication is not enabled for this account.');
  }

  const secretBase32 = decryptSecret(record.secretEncrypted);
  const verification = verifyTotpCode({
    secretBase32,
    code: input.code,
    lastUsedTimeStep: record.lastUsedTimeStep,
  });

  if (verification.valid && verification.timeStep !== undefined) {
    await recordTotpTimeStep(record.id, verification.timeStep);
    return;
  }

  // Not a valid TOTP code — try it as a recovery code before failing, so a
  // lost device isn't a lockout.
  if (await consumeRecoveryCode(record.recoveryCodes, input.code)) return;

  throw new HttpError(401, 'Invalid two-factor code.');
}

/** Recovery codes are compared against every unused hash (they're bcrypt,
 * so there's no lookup by value) and marked used on match. */
async function consumeRecoveryCode(
  candidates: { id: string; codeHash: string }[],
  submitted: string,
): Promise<boolean> {
  const normalized = normalizeRecoveryCode(submitted);
  for (const candidate of candidates) {
    if (await verifyPassword(normalized, candidate.codeHash)) {
      await markRecoveryCodeUsed(candidate.id);
      return true;
    }
  }
  return false;
}

/**
 * Disabling requires proof of possession: a current TOTP code or a
 * recovery code. A password-authenticated request alone is not enough —
 * that's the same credential an attacker who stole the password would
 * have.
 */
export async function disableTwoFactor(input: { userId: string; code: string }): Promise<void> {
  const record = await findTwoFactorByUserId(input.userId);
  if (!record?.enabledAt) throw new HttpError(400, 'Two-factor authentication is not enabled for this account.');

  const secretBase32 = decryptSecret(record.secretEncrypted);
  const verification = verifyTotpCode({
    secretBase32,
    code: input.code,
    lastUsedTimeStep: record.lastUsedTimeStep,
  });

  if (!verification.valid && !(await consumeRecoveryCode(record.recoveryCodes, input.code))) {
    throw new HttpError(401, 'Invalid two-factor code.');
  }

  await deleteTwoFactor(input.userId);
}

const RECOVERY_CODE_LENGTH = 10;

/** Unbiased sampling (rejection sampling rather than `byte % 30`, which
 * would skew toward the first six characters of the alphabet). */
function generateRecoveryCode(): string {
  const alphabetSize = RECOVERY_CODE_ALPHABET.length;
  const unbiasedLimit = Math.floor(256 / alphabetSize) * alphabetSize;
  const chars: string[] = [];

  while (chars.length < RECOVERY_CODE_LENGTH) {
    for (const byte of randomBytes(RECOVERY_CODE_LENGTH)) {
      if (byte >= unbiasedLimit) continue;
      chars.push(RECOVERY_CODE_ALPHABET[byte % alphabetSize]);
      if (chars.length === RECOVERY_CODE_LENGTH) break;
    }
  }

  return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}

/** Users paste codes with or without the dash, in any case. */
export function normalizeRecoveryCode(code: string): string {
  const stripped = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (stripped.length !== 10) return code.trim().toUpperCase();
  return `${stripped.slice(0, 5)}-${stripped.slice(5)}`;
}
