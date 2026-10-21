import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/modules/auth/services/rate-limit';
import { hashResetToken } from '../../src/modules/auth/services/password-reset';
import { passwordResetConfirmSchema, passwordResetRequestSchema } from '../../src/modules/auth/validation';

describe('passwordResetRequestSchema', () => {
  it('accepts a valid email', () => {
    expect(passwordResetRequestSchema.safeParse({ email: 'patient@example.com' }).success).toBe(true);
  });

  it('rejects a malformed email', () => {
    expect(passwordResetRequestSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });
});

describe('passwordResetConfirmSchema', () => {
  it('accepts a token with a long-enough password', () => {
    expect(passwordResetConfirmSchema.safeParse({ token: 'abc123', newPassword: 'longenough123' }).success).toBe(true);
  });

  it('rejects a reset that would set a weaker password than signup allows', () => {
    expect(passwordResetConfirmSchema.safeParse({ token: 'abc123', newPassword: 'short' }).success).toBe(false);
  });

  it('rejects an empty token', () => {
    expect(passwordResetConfirmSchema.safeParse({ token: '', newPassword: 'longenough123' }).success).toBe(false);
  });
});

describe('hashResetToken', () => {
  it('is deterministic and never returns the raw token', () => {
    const raw = 'raw-token-value';
    const hash = hashResetToken(raw);
    expect(hash).toBe(hashResetToken(raw));
    expect(hash).not.toContain(raw);
    // SHA-256 hex.
    expect(hash).toHaveLength(64);
  });

  it('gives different hashes for different tokens', () => {
    expect(hashResetToken('token-a')).not.toBe(hashResetToken('token-b'));
  });
});

describe('createRateLimiter', () => {
  it('allows up to the limit within the window, then blocks', () => {
    const limiter = createRateLimiter(3, 60_000);
    expect([1, 2, 3].map(() => limiter.consume('email:a'))).toEqual([true, true, true]);
    expect(limiter.consume('email:a')).toBe(false);
  });

  it('tracks keys independently', () => {
    const limiter = createRateLimiter(1, 60_000);
    expect(limiter.consume('email:a')).toBe(true);
    expect(limiter.consume('email:b')).toBe(true);
    expect(limiter.consume('email:a')).toBe(false);
  });

  it('resets once the window has elapsed', () => {
    const limiter = createRateLimiter(1, 1_000);
    const start = 1_000_000;
    expect(limiter.consume('ip:1', start)).toBe(true);
    expect(limiter.consume('ip:1', start + 500)).toBe(false);
    expect(limiter.consume('ip:1', start + 1_001)).toBe(true);
  });
});
