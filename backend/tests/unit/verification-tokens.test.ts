import { describe, expect, it } from 'vitest';
import {
  generateVerificationToken,
  hashVerificationToken,
} from '../../src/modules/auth/services/verification-tokens';

describe('email verification tokens (issue #34)', () => {
  it('generates a fresh, high-entropy token each time', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateVerificationToken()));
    expect(tokens.size).toBe(50);
    // 32 random bytes, base64url — 43 chars, URL-safe characters only.
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('hashes deterministically and never stores the raw token', () => {
    const token = generateVerificationToken();
    const hash = hashVerificationToken(token);
    expect(hash).toBe(hashVerificationToken(token));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
  });

  it('produces different hashes for different tokens', () => {
    expect(hashVerificationToken(generateVerificationToken())).not.toBe(
      hashVerificationToken(generateVerificationToken()),
    );
  });
});
