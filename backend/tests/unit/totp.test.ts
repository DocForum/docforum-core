import { describe, expect, it } from 'vitest';
import {
  TOTP_PERIOD_SECONDS,
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  timeStepFor,
  totpCodeAtStep,
  verifyTotpCode,
} from '../../src/modules/auth/services/totp';
import { normalizeRecoveryCode } from '../../src/modules/auth/services/two-factor';

// RFC 6238 §Appendix B uses the ASCII secret "12345678901234567890" for the
// SHA-1 vectors. Working from the RFC's own inputs (rather than values
// produced by this code) is the point — it pins the implementation to the
// spec, not to itself.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('RFC 6238 test vectors (SHA-1, 6 digits)', () => {
  const vectors: [number, string][] = [
    // [unix seconds, last 6 digits of the RFC's 8-digit expected value]
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];

  it.each(vectors)('matches the published code at T=%i', (epochSeconds, expected) => {
    expect(totpCodeAtStep(RFC_SECRET, timeStepFor(epochSeconds * 1000))).toBe(expected);
  });

  it('uses a 30-second period', () => {
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(timeStepFor(0)).toBe(0);
    expect(timeStepFor(29_000)).toBe(0);
    expect(timeStepFor(30_000)).toBe(1);
  });
});

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 128, 7]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('ignores padding and lowercase on decode', () => {
    expect(base32Decode('gezdgnbvgy3tqojqgezdgnbvgy3tqojq====')).toEqual(
      base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'),
    );
  });

  it('rejects a character outside the alphabet', () => {
    expect(() => base32Decode('ABC1!!!')).toThrow(/Invalid base32/);
  });
});

describe('generateTotpSecret', () => {
  it('produces a distinct 32-character base32 secret each time', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toHaveLength(32); // 20 bytes → 160 bits → 32 symbols
    expect(a).not.toBe(b);
  });
});

describe('verifyTotpCode', () => {
  const at = 1_600_000_000_000;

  it('accepts the current, previous and next step (±1 window)', () => {
    const step = timeStepFor(at);
    for (const offset of [-1, 0, 1]) {
      const code = totpCodeAtStep(RFC_SECRET, step + offset);
      expect(verifyTotpCode({ secretBase32: RFC_SECRET, code, at })).toEqual({ valid: true, timeStep: step + offset });
    }
  });

  it('rejects a code two steps away', () => {
    const step = timeStepFor(at);
    const code = totpCodeAtStep(RFC_SECRET, step + 2);
    expect(verifyTotpCode({ secretBase32: RFC_SECRET, code, at }).valid).toBe(false);
  });

  it('rejects a wrong code and malformed input', () => {
    expect(verifyTotpCode({ secretBase32: RFC_SECRET, code: '000000', at }).valid).toBe(false);
    expect(verifyTotpCode({ secretBase32: RFC_SECRET, code: '', at }).valid).toBe(false);
  });

  it('rejects replay of a step already spent, even inside the window', () => {
    const step = timeStepFor(at);
    const code = totpCodeAtStep(RFC_SECRET, step);
    // Already used the current step → the same code is a replay.
    expect(verifyTotpCode({ secretBase32: RFC_SECRET, code, at, lastUsedTimeStep: step }).valid).toBe(false);
    // The previous step's code is still acceptable while the current one
    // hasn't been spent.
    const previous = totpCodeAtStep(RFC_SECRET, step - 1);
    expect(verifyTotpCode({ secretBase32: RFC_SECRET, code: previous, at, lastUsedTimeStep: null }).valid).toBe(true);
  });
});

describe('buildOtpauthUri', () => {
  it('builds a scannable URI with the documented parameters', () => {
    const uri = buildOtpauthUri({ secretBase32: RFC_SECRET, label: 'doc@example.com', issuer: 'DocForum' });
    expect(uri.startsWith('otpauth://totp/')).toBe(true);

    const params = new URL(uri.replace('otpauth://', 'https://')).searchParams;
    expect(params.get('secret')).toBe(RFC_SECRET);
    expect(params.get('issuer')).toBe('DocForum');
    expect(params.get('algorithm')).toBe('SHA1');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
    expect(decodeURIComponent(uri)).toContain('DocForum:doc@example.com');
  });
});

describe('normalizeRecoveryCode', () => {
  it('accepts a code with or without its dash, in any case', () => {
    expect(normalizeRecoveryCode('abcde-fghjk')).toBe('ABCDE-FGHJK');
    expect(normalizeRecoveryCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
    expect(normalizeRecoveryCode('  abcde fghjk  ')).toBe('ABCDE-FGHJK');
  });
});
