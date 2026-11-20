// Token signing/verification. Every token carries `tv` (the user's
// refresh-token version at issue time) so bumping `User.tokenVersion`
// invalidates all outstanding tokens without a per-request DB read — the
// check happens where the token is actually exchanged (refresh).
import jwt from 'jsonwebtoken';
import { config, type JwtSigningKey } from '../../../config';
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
  /** Phase 8, issue #36: present only on the half-authenticated two-factor
   * tokens. `verifyAccessToken` refuses any token that carries it, so a
   * password-only step can never be used as a session. */
  typ?: MfaTokenType;
}

/** The two half-authenticated token kinds (issue #36).
 * - `mfa_pending`: password accepted, waiting for the TOTP/recovery code;
 *   only `POST /auth/2fa/verify` accepts it.
 * - `mfa_enrollment`: an admin who must enrol before getting a session;
 *   only `POST /auth/2fa/setup` and `/enable` accept it. */
export type MfaTokenType = 'mfa_pending' | 'mfa_enrollment';

export interface MfaTokenPayload extends AccessTokenPayload {
  typ: MfaTokenType;
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

/**
 * Sign with the current key (first in the keyring) and record its `kid` in
 * the header, so verification can pick the matching secret during rotation.
 */
function signWithKeyring(
  keys: readonly JwtSigningKey[],
  payload: object,
  expiresIn: NonNullable<jwt.SignOptions['expiresIn']>,
): string {
  const [current] = keys;
  return jwt.sign(payload, current.secret, { expiresIn, keyid: current.kid });
}

/**
 * Verify against the key named by the token's `kid`. A token with an unknown
 * `kid` is rejected, not checked against every key. A token without a `kid`
 * (minted before rotation support) is tried against each key in order.
 */
function verifyWithKeyring<T>(keys: JwtSigningKey[], token: string): T {
  const decoded = jwt.decode(token, { complete: true });
  const kid = typeof decoded?.header.kid === 'string' ? decoded.header.kid : undefined;
  const candidates = kid === undefined ? keys : keys.filter((key) => key.kid === kid);
  if (candidates.length === 0) {
    throw new jwt.JsonWebTokenError('Unknown signing key');
  }

  let lastError: unknown;
  for (const key of candidates) {
    try {
      return jwt.verify(token, key.secret) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return signWithKeyring(config.jwt.accessKeys, payload, config.jwt.accessTtl);
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  return signWithKeyring(config.jwt.refreshKeys, payload, config.jwt.refreshTtl);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = verifyWithKeyring<AccessTokenPayload>(config.jwt.accessKeys, token);
  // Issue #36: a half-authenticated token is signed with the same keyring so
  // it can be verified without server state, but it is NOT an access token.
  // Rejecting here keeps every route guarded by `authenticate` safe.
  if (payload.typ) throw new jwt.JsonWebTokenError('Not an access token.');
  return payload;
}

/** Signs the short-lived half-authenticated token (issue #36). */
export function signMfaToken(payload: MfaTokenPayload): string {
  return signWithKeyring(
    config.jwt.accessKeys,
    payload,
    `${config.twoFactor.mfaTokenTtlMinutes}m` as NonNullable<jwt.SignOptions['expiresIn']>,
  );
}

/** Verifies a half-authenticated token and asserts its kind — an
 * `mfa_pending` token is useless on the enrolment endpoints and vice versa. */
export function verifyMfaToken(token: string, expected: MfaTokenType): MfaTokenPayload {
  const payload = verifyWithKeyring<MfaTokenPayload>(config.jwt.accessKeys, token);
  if (payload.typ !== expected) throw new jwt.JsonWebTokenError('Wrong two-factor token type.');
  return payload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return verifyWithKeyring<RefreshTokenPayload>(config.jwt.refreshKeys, token);
}
