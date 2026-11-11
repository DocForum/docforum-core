// TOTP (RFC 6238) over HMAC-SHA1, implemented on node:crypto.
//
// Deliberately dependency-free: this is ~60 lines of well-specified
// algorithm, and the whole point of choosing TOTP over SMS was to avoid a
// provider dependency (issue #36). Adding a crypto dependency to save those
// lines would trade a spec we can test against published RFC vectors for a
// package we'd have to trust and update. Correctness is pinned by the RFC
// 6238 test vectors in tests/unit/totp.test.ts.
import { createHmac, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_SECRET_BYTES = 20; // 160 bits — RFC 4226 §4 recommended minimum
/** ±1 time step (~±30s) of clock skew tolerated, per the issue. */
export const TOTP_WINDOW = 1;

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
  const normalized = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

export function timeStepFor(at: Date | number = Date.now()): number {
  const ms = at instanceof Date ? at.getTime() : at;
  return Math.floor(ms / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for one specific time step — the primitive; callers pass an
 * explicit step so a test can pin RFC vectors. */
export function totpCodeAtStep(secretBase32: string, timeStep: number, digits = TOTP_DIGITS): string {
  const key = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timeStep));

  const digest = createHmac('sha1', key).update(counter).digest();
  // RFC 4226 §5.3 dynamic truncation.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export interface TotpVerification {
  valid: boolean;
  /** The time step the submitted code matched, when valid. Callers persist
   * this and reject anything <= it later — that's the replay guard. */
  timeStep?: number;
}

/**
 * Verifies a submitted code against the current step and its neighbours.
 * `lastUsedTimeStep` (the highest step this user has already spent) is
 * checked here too, so a code can't be replayed inside its own validity
 * window.
 */
export function verifyTotpCode(input: {
  secretBase32: string;
  code: string;
  at?: Date | number;
  lastUsedTimeStep?: bigint | number | null;
}): TotpVerification {
  const current = timeStepFor(input.at);
  const lastUsed = input.lastUsedTimeStep == null ? null : BigInt(input.lastUsedTimeStep);
  const submitted = input.code.trim();

  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const step = current + offset;
    if (totpCodeAtStep(input.secretBase32, step) !== submitted) continue;
    if (lastUsed !== null && BigInt(step) <= lastUsed) {
      // Right code, but this step's code has already been spent.
      return { valid: false };
    }
    return { valid: true, timeStep: step };
  }

  return { valid: false };
}

/** The `otpauth://` URI a client renders as a QR code. */
export function buildOtpauthUri(input: { secretBase32: string; label: string; issuer: string }): string {
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  const label = encodeURIComponent(`${input.issuer}:${input.label}`);
  return `otpauth://totp/${label}?${params.toString()}`;
}
