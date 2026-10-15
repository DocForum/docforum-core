import type { NextFunction, Request, Response } from 'express';
import { assertEmailVerified, verifyAccessToken } from '../modules/auth/services';
import { HttpError } from '../http-error';
import type { Role } from '@prisma/client';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; role: Role };
    }
  }
}

/** Verifies the `Authorization: Bearer <accessToken>` header and attaches
 * `req.user`. Throws 401 if missing/invalid/expired — there is no
 * revocation list yet, so an expired token is the only way an access
 * token stops working before its 15-minute TTL (see config/index.ts). */
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Missing or malformed Authorization header.');
  }

  try {
    const payload = verifyAccessToken(header.slice('Bearer '.length));
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    throw new HttpError(401, 'Invalid or expired access token.');
  }
}

/** Must run after `authenticate`. Rejects with `403 EMAIL_NOT_VERIFIED`
 * (Phase 8, issue #34) when the caller's own address hasn't been verified.
 * Applied only to mutations that need a trustworthy contact address —
 * booking and payments — never to login/browsing.
 *
 * This is a DB read, so verifying the address in another tab unblocks the
 * caller immediately, instead of after their access token's 15-minute TTL.
 * It is deliberately *not* the doctor/facility `verificationStatus` gate:
 * that is a separate, manual credential review (§4.1). */
export async function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  await assertEmailVerified(req.user.id);
  next();
}

/** Must run after `authenticate`. Rejects with 403 if the authenticated
 * user's role isn't in the allowed set. */
export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new HttpError(401, 'Authentication required.');
    if (!allowedRoles.includes(req.user.role)) {
      throw new HttpError(403, 'You do not have permission to perform this action.');
    }
    next();
  };
}
