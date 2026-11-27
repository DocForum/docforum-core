import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import { requireIfMatch } from '../../../middleware/optimistic-concurrency';
import { apiRateLimit } from '../../../middleware/rate-limit';
import * as facilitiesController from '../controllers';

export const facilitiesRouter = Router();

// Facility accounts are admin-created only (PRD OQ-2 — curated partner list,
// no self-serve facility signup; `POST /auth/signup` refuses the role).
// Server-side gate, same pattern as admin-gated doctor verification in
// Phase 1. Tested in backend/tests/integration/facility-creation-matching.
facilitiesRouter.post(
  '/',
  authenticate,
  requireRole('admin'),
  facilitiesController.createFacility,
);

// Self-service profile (issue #319). Declared before `/:facilityId/prices` so
// the literal `/me` segment is never captured as a facilityId.
facilitiesRouter.get('/me', apiRateLimit, authenticate, requireRole('facility'), facilitiesController.getOwnProfile);
facilitiesRouter.patch(
  '/me',
  apiRateLimit,
  authenticate,
  requireRole('facility'),
  requireIfMatch,
  facilitiesController.updateOwnProfile,
);

// Price management is scoped to "my facility": the owner's profile is looked
// up from the authenticated user, so there is no client-supplied id to forge.
facilitiesRouter.get('/me/prices', authenticate, requireRole('facility'), facilitiesController.listOwnPrices);
facilitiesRouter.post('/me/verify-order', authenticate, requireRole('facility'), facilitiesController.verifyOrder);
facilitiesRouter.post(
  '/me/prices',
  authenticate,
  requireRole('facility'),
  requireVerifiedEmail,
  facilitiesController.createOwnPrice,
);

// Retire a price item (facility-only write; `/retire` before `/:priceId` so
// the literal is not captured as a price id).
facilitiesRouter.post(
  '/me/prices/retire',
  authenticate,
  requireRole('facility'),
  requireVerifiedEmail,
  facilitiesController.retireOwnPriceItem,
);

// Admin capability management (issue #320). Removing only affects future
// eligibility matching — routed orders carry their own facilityId FK.
facilitiesRouter.post(
  '/:facilityId/capabilities',
  authenticate,
  requireRole('admin'),
  facilitiesController.addCapability,
);
facilitiesRouter.delete(
  '/:facilityId/capabilities/:capabilityId',
  authenticate,
  requireRole('admin'),
  facilitiesController.removeCapability,
);

// Public reads. `/eligible` is declared before `/:facilityId/prices` so the
// literal segment is never captured as an id (Express 5 matches in order).
facilitiesRouter.get('/eligible', facilitiesController.eligibleFacilities);
facilitiesRouter.get('/:facilityId/prices', facilitiesController.listFacilityPrices);
