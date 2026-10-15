import { describe, expect, it } from 'vitest';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../../src/modules/auth/services/tokens';

describe('access tokens', () => {
  it('round-trips the payload', () => {
    const token = signAccessToken({ sub: 'user-1', role: 'patient' });
    const payload = verifyAccessToken(token);
    expect(payload.sub).toBe('user-1');
    expect(payload.role).toBe('patient');
  });

  it('rejects a token signed with a different secret', () => {
    // Simulates a refresh token being presented where an access token is
    // expected — they're signed with different secrets on purpose.
    const refreshToken = signRefreshToken({ sub: 'user-1', role: 'patient', csrf: 'session-csrf' });
    expect(() => verifyAccessToken(refreshToken)).toThrow();
  });

  it('rejects a garbage token', () => {
    expect(() => verifyAccessToken('not-a-real-token')).toThrow();
  });
});

describe('refresh tokens', () => {
  it('round-trips the payload', () => {
    const token = signRefreshToken({ sub: 'user-2', role: 'doctor', csrf: 'csrf-value' });
    const payload = verifyRefreshToken(token);
    expect(payload.sub).toBe('user-2');
    expect(payload.role).toBe('doctor');
  });

  // Phase 8, issue #37: the session's CSRF token rides inside the refresh
  // token, so it rotates with it and needs no server-side state.
  it('carries the CSRF token bound to the session', () => {
    const token = signRefreshToken({ sub: 'user-3', role: 'patient', csrf: 'session-csrf' });
    expect(verifyRefreshToken(token).csrf).toBe('session-csrf');
  });

  it('still rejects a refresh token signed with the wrong secret', () => {
    const accessToken = signAccessToken({ sub: 'user-4', role: 'patient' });
    expect(() => verifyRefreshToken(accessToken)).toThrow();
  });
});
