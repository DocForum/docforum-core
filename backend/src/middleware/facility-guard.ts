import { Request, Response, NextFunction } from 'express';
import { HttpError } from '../http-error';
import { prisma } from '../db/prisma-client';
import type { FacilityRole } from '@prisma/client';

export interface FacilityContext {
  facilityId: string;
  memberRole: FacilityRole | null;
  isOwner: boolean;
  isMember: boolean;
}

/** Must run after `authenticate`. Resolves the authenticated user's
 * membership in a facility via FacilityMember. Expects `req.headers.x-facility-id`
 * or the facility id to be extracted from the JWT payload / context.
 * Alternatively, can be given a facilityId from the route params.
 *
 * Attaches `req.facility` with { id, memberRole, isOwner, isMember }.
 *
 * If the user is not a member of the given facility, req.facility is set
 * to null and a 403 is returned (or the caller can check). */
export async function requireFacility(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user) {
    throw new HttpError(401, 'Authentication required.');
  }

  // Get facilityId from the route params (e.g. /facilities/:facilityId/...).
  // `requireFacilityId` may have attached it already for non-REST paths; the
  // param is the normal case, so fall back to it rather than 400 on every
  // /facilities/:facilityId/* route.
  const facilityId = (req as any).facilityId ?? req.params.facilityId;
  if (!facilityId) {
    throw new HttpError(400, 'Facility ID is required.');
  }

  // Look up the user's membership in this facility
  const member = await prisma.facilityMember.findFirst({
    where: { facilityId, userId: req.user.id },
  });

  const isOwner = !!member && member.role === 'owner';
  const isMember = !!member;

  ;(req as any).facility = {
    id: facilityId,
    memberRole: member ? member.role : null,
    isOwner,
    isMember,
  };

  next();
}

/** Convenience: extract facilityId from route params and attach facility context.
 * Usage: app.use('/facilities/:facilityId/*', requireFacility); */
export function requireFacilityId(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const facilityId = (req as any).params.facilityId;
  if (!facilityId) {
    throw new HttpError(400, 'Facility ID is required in route params.');
  }
  ;(req as any).facilityId = facilityId;
  next();
}

/** Guard: only proceed if the authenticated user is an owner of the facility. */
export function requireFacilityOwner(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const facility = (req as any).facility;
  if (!facility || !facility.isOwner) {
    throw new HttpError(403, 'You do not have permission to perform this action.');
  }
  next();
}

/** Guard: only proceed if the authenticated user is a member (owner or staff) of the facility. */
export function requireFacilityMember(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const facility = (req as any).facility;
  if (!facility || !facility.isMember) {
    throw new HttpError(403, 'You do not have permission to perform this action.');
  }
  next();
}