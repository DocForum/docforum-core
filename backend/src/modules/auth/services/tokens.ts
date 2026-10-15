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
  /** User.tokenVersion at issue time. Compared at refresh time. */
  tv?: number;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, config.jwt.accessSecret, { expiresIn: config.jwt.accessTtl });
}

export function signRefreshToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshTtl });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.jwt.accessSecret) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.jwt.refreshSecret) as AccessTokenPayload;
}
