import { Router } from 'express';
import {
  listMembers,
  removeMember,
  createInvite,
  listInvites,
  revokeInvite,
  acceptInvite,
} from '../controllers';
import { authenticate } from '../../../middleware/auth';
import {
  requireFacility,
  requireFacilityOwner,
} from '../../../middleware/facility-guard';

export const facilitiesRouter = Router();

// ── Member management ──────────────────────────────────────────────────

// GET /facilities/:facilityId/members — list all members of a facility
facilitiesRouter.get(
  '/:facilityId/members',
  authenticate,
  requireFacility,
  requireFacilityOwner,
  listMembers,
);

// DELETE /facilities/:facilityId/members/:userId — remove a staff member
facilitiesRouter.delete(
  '/:facilityId/members/:userId',
  authenticate,
  requireFacility,
  requireFacilityOwner,
  removeMember,
);

// ── Invite management ──────────────────────────────────────────────────

// POST /facilities/:facilityId/invites — owner invites staff by email
facilitiesRouter.post(
  '/:facilityId/invites',
  authenticate,
  requireFacility,
  requireFacilityOwner,
  createInvite,
);

// GET /facilities/:facilityId/invites — list pending invites (owner-only)
facilitiesRouter.get(
  '/:facilityId/invites',
  authenticate,
  requireFacility,
  requireFacilityOwner,
  listInvites,
);

// DELETE /facilities/:facilityId/invites/:tokenHash — revoke a pending invite
facilitiesRouter.delete(
  '/:facilityId/invites/:tokenHash',
  authenticate,
  requireFacility,
  requireFacilityOwner,
  revokeInvite,
);

// ── Accept invite ──────────────────────────────────────────────────────

// POST /facilities/invites/accept — accept an invite (new user or existing user)
// Deliberately NOT behind `authenticate`: a brand-new staff member has no
// account yet, so they cannot present an access token. The invite token is
// the credential here.
facilitiesRouter.post(
  '/invites/accept',
  acceptInvite,
);