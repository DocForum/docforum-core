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
  /** Refresh-session id (Phase 8 #38). Present only on refresh tokens —
   * the access token stays stateless so protected requests don't need a
   * session lookup. */
  sid?: string;
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

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.jwt.accessSecret) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, config.jwt.refreshSecret) as RefreshTokenPayload;
}
