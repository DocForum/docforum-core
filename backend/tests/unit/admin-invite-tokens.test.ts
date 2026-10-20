import { describe, expect, it } from 'vitest';
import {
  generateAdminInviteToken,
  hashAdminInviteToken,
} from '../../src/modules/users/services/invite-tokens';

describe('admin invite tokens (issue #39)', () => {
  it('generates a fresh, URL-safe token each time', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateAdminInviteToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('hashes deterministically and never stores the raw token', () => {
    const token = generateAdminInviteToken();
    const hash = hashAdminInviteToken(token);
    expect(hash).toBe(hashAdminInviteToken(token));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
  });

  it('produces different hashes for different tokens', () => {
    expect(hashAdminInviteToken(generateAdminInviteToken())).not.toBe(hashAdminInviteToken(generateAdminInviteToken()));
  });
});
