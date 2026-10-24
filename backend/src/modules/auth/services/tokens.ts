// Token signing/verification. Every token carries `tv` (the user's
// refresh-token version at issue time) so bumping `User.tokenVersion`
// invalidates all outstanding tokens without a per-request DB read — the
// check happens where the token is actually exchanged (refresh).
import jwt from 'jsonwebtoken';
import { config } from '../../../config';
import type { Role } from '@prisma/client';

export interface AccessTokenPayload {
  sub: string; // user id
  role: Role;
  /** Signup preference used to localize request errors without another DB read. */
  locale?: string;
  /** Issued-at, set by `jsonwebtoken` itself. Read by the auth middleware to
   * compare against `User.sessionsInvalidatedAt` (Phase 8, issue #39) —
   * tokens minted before a deactivation must stop working immediately. */
  iat?: number;
  /** Refresh-session id (Phase 8 #38). Present only on refresh tokens —
   * the access token stays stateless so protected requests don't need a
   * session lookup. */
  sid?: string;
  /** User.tokenVersion at issue time. Compared at refresh time (Phase 8 #33). */
  tv?: number;
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
  /** User.tokenVersion at issue time. Compared at refresh time (Phase 8 #33).
   * Bumping User.tokenVersion invalidates all previously issued refresh tokens. */
  tv: number;
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
