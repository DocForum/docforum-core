// Unit tests for the TOTP primitives (Phase 8, issue #36).
//
// The HOTP/TOTP vectors are the published RFC 4226 Appendix D and RFC 6238
// Appendix B ones, so a regression in the algorithm is caught against the
// specification rather than against our own output.
import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  hotp,
  TOTP_PERIOD_SECONDS,
  timeStep,
  verifyTotp,
} from '../../src/modules/auth/services/totp';

// RFC 6238's SHA-1 seed: the ASCII string "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('round-trips random bytes', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7a, 0x2b, 0x99]);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it('encodes the RFC secret to the documented value', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('mints a 160-bit secret by default', () => {
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });
});

describe('hotp (RFC 4226 Appendix D)', () => {
  const secret = base32Decode(RFC_SECRET);
  // Counter values 0..9 from the RFC's test table, 6-digit truncation.
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];

  it.each(expected.map((code, counter) => [counter, code]))('counter %i → %s', (counter, code) => {
    expect(hotp(secret, Number(counter))).toBe(code);
  });
});

describe('totp (RFC 6238 Appendix B, SHA-1)', () => {
  it.each([
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_111_111_111, '050471'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
    [20_000_000_000, '353130'],
  ])('T=%i → %s (6-digit truncation)', (seconds, code) => {
    // 8-digit RFC values truncated to our 6 digits.
    expect(hotp(base32Decode(RFC_SECRET), Math.floor(seconds / TOTP_PERIOD_SECONDS))).toBe(code);
  });
});

describe('verifyTotp', () => {
  const now = 1_700_000_000_000; // a fixed instant, not the wall clock

  it('accepts the current step and reports which step matched', () => {
    const code = hotp(base32Decode(RFC_SECRET), timeStep(now));
    expect(verifyTotp(RFC_SECRET, code, now)).toEqual({ step: timeStep(now) });
  });

  it('accepts ±1 step for clock skew, and nothing beyond it', () => {
    const previous = hotp(base32Decode(RFC_SECRET), timeStep(now) - 1);
    const next = hotp(base32Decode(RFC_SECRET), timeStep(now) + 1);
    const tooOld = hotp(base32Decode(RFC_SECRET), timeStep(now) - 2);
    const tooNew = hotp(base32Decode(RFC_SECRET), timeStep(now) + 2);

    expect(verifyTotp(RFC_SECRET, previous, now)).toEqual({ step: timeStep(now) - 1 });
    expect(verifyTotp(RFC_SECRET, next, now)).toEqual({ step: timeStep(now) + 1 });
    expect(verifyTotp(RFC_SECRET, tooOld, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, tooNew, now)).toBeNull();
  });

  it('ignores spaces in a hand-typed code and rejects non-digits', () => {
    const code = hotp(base32Decode(RFC_SECRET), timeStep(now));
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(RFC_SECRET, spaced, now)).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '', now)).toBeNull();
  });
});

describe('otpauth URI', () => {
  it('encodes the label, issuer and parameters authenticator apps expect', () => {
    const uri = buildOtpauthUri({ secret: 'ABC234', account: 'doc@example.com', issuer: 'DocForum' });
    expect(uri.startsWith('otpauth://totp/DocForum:doc%40example.com?')).toBe(true);
    const params = new URLSearchParams(uri.split('?')[1]);
    expect(params.get('secret')).toBe('ABC234');
    expect(params.get('issuer')).toBe('DocForum');
    expect(params.get('algorithm')).toBe('SHA1');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
  });
});
