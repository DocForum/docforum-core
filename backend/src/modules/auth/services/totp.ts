// TOTP (RFC 6238) over HOTP (RFC 4226) — no third-party dependency.
//
// Phase 8, issue #36. The algorithm is small and fully specified, so this is
// built on `node:crypto` rather than adding an auth library: the secret never
// leaves this module, verification is constant-time, and the replay window is
// explicit. Anything that needs an enrolled secret reads it through the
// two-factor service, which decrypts it (issue #46's field encryption).
import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** RFC 6238 recommends 20 bytes (160 bits) for HMAC-SHA1. */
const SECRET_BYTES = 20;

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/**
 * ±1 time step (so one code stays usable for up to ~90s, tolerating clock
 * skew) as the issue requires. The replay guard in the service makes the
 * wider window safe: a code is only accepted once per step.
 */
export const TOTP_WINDOW_STEPS = 1;

/** Base32 (RFC 4648, no padding) — the encoding every authenticator app
 * expects for a manually entered secret. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const normalised = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalised) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error('Invalid base32 character.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret, encoded for the otpauth URI. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

/** HOTP for one counter value (RFC 4226 §5.3). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function timeStep(atMs = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for a given instant — used by the tests and by nothing else;
 * production verification always recomputes from the clock. */
export function generateTotp(secretBase32: string, atMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), timeStep(atMs));
}

export interface TotpVerification {
  /** The time step the submitted code belongs to. Persisting it is what
   * rejects a replay of the same code within its window. */
  step: number;
}

/**
 * Verifies a submitted code against the current time step ± TOTP_WINDOW_STEPS.
 * Returns the matched step, or null. Every candidate is compared with
 * `timingSafeEqual`, and the loop never short-circuits, so the response time
 * doesn't reveal which step (if any) matched.
 */
export function verifyTotp(secretBase32: string, submitted: string, atMs = Date.now()): TotpVerification | null {
  const code = submitted.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return null;

  const secret = base32Decode(secretBase32);
  const current = timeStep(atMs);
  let matched: number | null = null;
  for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;
    const candidate = Buffer.from(hotp(secret, step));
    if (crypto.timingSafeEqual(Buffer.from(code), candidate) && matched === null) {
      matched = step;
    }
  }
  return matched === null ? null : { step: matched };
}

/** The `otpauth://` URI an authenticator app scans (RFC 6238 §? / Key URI
 * Format). The issuer label is percent-encoded, as the format requires. */
export function buildOtpauthUri(input: {
  secret: string;
  account: string;
  issuer: string;
  digits?: number;
  period?: number;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(input.digits ?? TOTP_DIGITS),
    period: String(input.period ?? TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
