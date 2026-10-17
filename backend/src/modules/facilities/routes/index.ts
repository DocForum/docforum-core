import { Router } from 'express';
import { authenticate } from '../../../middleware/auth';
import * as facilitiesController from '../controllers';

export const facilitiesRouter = Router();

// PRD FR-13 / issue #74 — facilities qualified for an order type,
// optionally sorted by distance from the patient's `near=lat,lng` point.
// Signed-in users only (the patient's point must never be public-facing
// beyond this response); the coordinates themselves are never stored.
facilitiesRouter.get('/eligible', authenticate, facilitiesController.listEligibleFacilities);
