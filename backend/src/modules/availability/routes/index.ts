import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as availabilityController from '../controllers';

export const availabilityRouter = Router();

// Public read — a patient must be able to see open slots before signing in
// to decide who to book. No PHI is exposed here (just doctor id + times).
availabilityRouter.get('/doctors/:doctorProfileId/slots', availabilityController.listSlots);

availabilityRouter.post(
  '/doctors/:doctorProfileId/slots/generate',
  authenticate,
  requireRole('doctor'),
  availabilityController.generateSlots,
);
