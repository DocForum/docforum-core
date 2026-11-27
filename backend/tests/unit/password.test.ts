import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  isCommonPassword,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
} from '../../src/modules/auth/services/password';
import { passwordSchema } from '../../src/modules/auth/validation';
import { HttpError } from '../../src/http-error';

describe('password hashing and verification', () => {
  it('never stores the plaintext password in the hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).not.toContain('correct horse battery staple');
  });

  it('verifies a matching password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects a non-matching password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
  });

  it('preserves login verification for existing users with passwords longer than 72 bytes', async () => {
    // Existing accounts created before the 72-byte boundary must still be able to log in.
    const longPassword = 'A'.repeat(80);
    const hash = await hashPassword(longPassword);
    // Bcrypt compares only the first 72 bytes
    await expect(verifyPassword(longPassword, hash)).resolves.toBe(true);
  });
});

describe('password strength validation (Issue #269)', () => {
  it('accepts valid passwords between 8 characters and 72 bytes', () => {
    expect(() => validatePasswordStrength('valid-secure-pass-123')).not.toThrow();
  });

  it('rejects passwords shorter than 8 characters', () => {
    expect(() => validatePasswordStrength('short1')).toThrow(HttpError);
    try {
      validatePasswordStrength('short1');
    } catch (err: any) {
      expect(err.status).toBe(400);
      expect(err.code).toBe('PASSWORD_TOO_SHORT');
    }
  });

  it('rejects passwords longer than 72 bytes with ASCII input', () => {
    const password72 = 'a'.repeat(72);
    expect(Buffer.byteLength(password72, 'utf8')).toBe(72);
    expect(() => validatePasswordStrength(password72)).not.toThrow();

    const password73 = 'a'.repeat(73);
    expect(Buffer.byteLength(password73, 'utf8')).toBe(73);
    expect(() => validatePasswordStrength(password73)).toThrow(HttpError);
    try {
      validatePasswordStrength(password73);
    } catch (err: any) {
      expect(err.status).toBe(400);
      expect(err.code).toBe('PASSWORD_TOO_LONG');
    }
  });

  it('measures length in UTF-8 bytes rather than characters for multi-byte input', () => {
    // Multi-byte character: Euro sign '€' is 3 bytes in UTF-8
    // 24 Euro characters = 24 chars, but 24 * 3 = 72 bytes -> exactly at limit
    const exact72Bytes = '€'.repeat(24);
    expect(exact72Bytes.length).toBe(24);
    expect(Buffer.byteLength(exact72Bytes, 'utf8')).toBe(72);
    expect(() => validatePasswordStrength(exact72Bytes)).not.toThrow();

    // 25 Euro characters = 25 chars (< 72 chars), but 25 * 3 = 75 bytes (> 72 bytes)
    const over72Bytes = '€'.repeat(25);
    expect(over72Bytes.length).toBe(25);
    expect(Buffer.byteLength(over72Bytes, 'utf8')).toBe(75);
    expect(() => validatePasswordStrength(over72Bytes)).toThrow(HttpError);
    try {
      validatePasswordStrength(over72Bytes);
    } catch (err: any) {
      expect(err.status).toBe(400);
      expect(err.code).toBe('PASSWORD_TOO_LONG');
    }

    // 4-byte characters: 20 characters = 20 chars, but 20 * 4 = 80 bytes
    const fourByteChars = '𝄢'.repeat(20);
    expect(fourByteChars.length).toBe(40); // surrogate pairs in JS string length
    expect(Buffer.byteLength(fourByteChars, 'utf8')).toBe(80);
    expect(() => validatePasswordStrength(fourByteChars)).toThrow(HttpError);
    try {
      validatePasswordStrength(fourByteChars);
    } catch (err: any) {
      expect(err.status).toBe(400);
      expect(err.code).toBe('PASSWORD_TOO_LONG');
    }
  });

  it('detects and rejects commonly breached passwords from the static denylist', () => {
    const commonSamples = ['password', '12345678', 'qwerty123', 'admin123', 'welcome1'];
    for (const common of commonSamples) {
      expect(isCommonPassword(common)).toBe(true);
      expect(() => validatePasswordStrength(common)).toThrow(HttpError);
      try {
        validatePasswordStrength(common);
      } catch (err: any) {
        expect(err.status).toBe(400);
        expect(err.code).toBe('PASSWORD_COMMONLY_BREACHED');
      }
    }
  });

  it('performs case-insensitive matching against the denylist', () => {
    expect(isCommonPassword('PASSWORD')).toBe(true);
    expect(isCommonPassword('Admin123')).toBe(true);
    expect(isCommonPassword('Welcome1')).toBe(true);
  });

  it('allows strong unique passwords that are not in the denylist', () => {
    expect(isCommonPassword('Tr0ub4dor&3-Correct-Horse')).toBe(false);
    expect(() => validatePasswordStrength('Tr0ub4dor&3-Correct-Horse')).not.toThrow();
  });
});

describe('passwordSchema Zod validation', () => {
  it('parses valid passwords', () => {
    const result = passwordSchema.safeParse('SuperSecretPass123!');
    expect(result.success).toBe(true);
  });

  it('exports expected boundary constants', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(MAX_PASSWORD_BYTES).toBe(72);
  });

  it('fails with code on passwords shorter than 8 chars', () => {
    const result = passwordSchema.safeParse('short');
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0] as unknown as { params?: { code?: string } };
      expect(issue.params?.code).toBe('PASSWORD_TOO_SHORT');
    }
  });

  it('fails with code on passwords exceeding 72 bytes', () => {
    const result = passwordSchema.safeParse('€'.repeat(25));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0] as unknown as { params?: { code?: string } };
      expect(issue.params?.code).toBe('PASSWORD_TOO_LONG');
    }
  });

  it('fails with code on commonly breached passwords', () => {
    const result = passwordSchema.safeParse('password');
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0] as unknown as { params?: { code?: string } };
      expect(issue.params?.code).toBe('PASSWORD_COMMONLY_BREACHED');
    }
  });
});
