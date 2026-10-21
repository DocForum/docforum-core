import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import * as facilitiesController from '../controllers';

export const facilitiesRouter = Router();

// Price management is scoped to "my facility": the owner's profile is looked
// up from the authenticated user, so there is no client-supplied id to forge.
facilitiesRouter.get('/me/prices', authenticate, requireRole('facility'), facilitiesController.listOwnPrices);
facilitiesRouter.post(
  '/me/prices',
  authenticate,
  requireRole('facility'),
  requireVerifiedEmail,
  facilitiesController.createOwnPrice,
);

// Public reads. `/eligible` is declared before `/:facilityId/prices` so the
// literal segment is never captured as an id (Express 5 matches in order).
facilitiesRouter.get('/eligible', facilitiesController.eligibleFacilities);
facilitiesRouter.get('/:facilityId/prices', facilitiesController.listFacilityPrices);
