// Token signing/verification.
//
// `scope` is what keeps the half-authenticated 2FA token (Phase 8 #36)
// from being mistaken for a real access token: it's signed with the same
// secret, but `verifyAccessToken` rejects anything carrying a `scope`, so
// `authenticate` — and therefore every protected route — refuses it. Only
// `verifyMfaPendingToken` accepts it, and only POST /auth/2fa/verify calls
// that.
import jwt from 'jsonwebtoken';
import { config } from '../../../config';
import type { Role } from '@prisma/client';

export interface AccessTokenPayload {
  sub: string; // user id
  role: Role;
  /** Issued-at, set by `jsonwebtoken` itself. Read by the auth middleware to
   * compare against `User.sessionsInvalidatedAt` (Phase 8, issue #39) —
   * tokens minted before a deactivation must stop working immediately. */
  iat?: number;
  /** Present only on single-purpose tokens (currently `mfa_pending`). All
   * other token types must leave it undefined. */
  scope?: 'mfa_pending';
}

/**
 * The refresh token additionally carries the session's CSRF token (Phase 8,
 * issue #37). Binding it here rather than storing it means the CSRF check is
 * stateless and rotates with the refresh token itself: a token minted before
 * this change has no `csrf` claim and is therefore rejected by
 * `refresh()` — a pre-existing refresh cookie forces one re-login, which is
 * the honest cost of closing the hole.
 */
export interface RefreshTokenPayload extends AccessTokenPayload {
  csrf: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, config.jwt.accessSecret, { expiresIn: config.jwt.accessTtl });
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshTtl });
}

/** Issued in place of a session when the password step passes but the TOTP
 * step hasn't happened yet. Short-lived and single-purpose on purpose. */
export function signMfaPendingToken(payload: AccessTokenPayload): string {
  return jwt.sign({ ...payload, scope: 'mfa_pending' }, config.jwt.accessSecret, {
    expiresIn: config.twoFactor.mfaPendingTtl,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, config.jwt.accessSecret) as AccessTokenPayload;
  // A scoped token is not an access token, whatever signature it carries.
  if (payload.scope !== undefined) throw new Error('Token is not an access token.');
  return payload;
}

export function verifyMfaPendingToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, config.jwt.accessSecret) as AccessTokenPayload;
  if (payload.scope !== 'mfa_pending') throw new Error('Token is not an mfa_pending token.');
  return payload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, config.jwt.refreshSecret) as RefreshTokenPayload;
}
