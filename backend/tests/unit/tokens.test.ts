import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config';
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

// Key rotation (issue #106): new tokens are signed with the current key and
// carry its kid; tokens from the previous key verify only while that key is
// still in the keyring.
describe('access token key rotation', () => {
  const originalKeys = config.jwt.accessKeys;

  function withKeyring(keys: typeof originalKeys) {
    // config is `as const`; the keyring is swapped only inside this suite.
    (config.jwt as { accessKeys: typeof originalKeys }).accessKeys = keys;
  }

  it('signs with the current key and records its kid in the header', () => {
    const token = signAccessToken({ sub: 'user-r1', role: 'patient' });
    const header = jwt.decode(token, { complete: true })?.header;
    expect(header?.kid).toBe(originalKeys[0].kid);
  });

  it('accepts a token from the previous key during the overlap window', () => {
    const previous = { kid: 'access-old', secret: 'previous-secret-value-0123456789' };
    const oldToken = jwt.sign({ sub: 'user-r2', role: 'patient' }, previous.secret, {
      expiresIn: '5m',
      keyid: previous.kid,
    });
    withKeyring([originalKeys[0], previous]);
    try {
      expect(verifyAccessToken(oldToken).sub).toBe('user-r2');
    } finally {
      withKeyring(originalKeys);
    }
  });

  it('rejects the previous key once it has been removed from the keyring', () => {
    const previous = { kid: 'access-old', secret: 'previous-secret-value-0123456789' };
    const oldToken = jwt.sign({ sub: 'user-r3', role: 'patient' }, previous.secret, {
      expiresIn: '5m',
      keyid: previous.kid,
    });
    expect(() => verifyAccessToken(oldToken)).toThrow();
  });

  it('rejects a token whose kid is not in the keyring', () => {
    const token = jwt.sign({ sub: 'user-r4', role: 'patient' }, originalKeys[0].secret, {
      expiresIn: '5m',
      keyid: 'unknown-kid',
    });
    expect(() => verifyAccessToken(token)).toThrow();
  });

  it('still verifies a legacy token that has no kid header', () => {
    const legacy = jwt.sign({ sub: 'user-r5', role: 'patient' }, originalKeys[0].secret, { expiresIn: '5m' });
    expect(verifyAccessToken(legacy).sub).toBe('user-r5');
  });
});
