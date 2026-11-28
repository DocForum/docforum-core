import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import { requireIfMatch } from '../../../middleware/optimistic-concurrency';
import { apiRateLimit } from '../../../middleware/rate-limit';
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

// Closure calendar (Phase 2, issue #131).
//
// The public list is deliberately unauthenticated: a closure is operational
// data ("the clinic is shut on 25 December"), never patient data. Writes are
// admin-only, and PATCH is If-Match guarded like every other mutable record.
// The admin routes carry the same per-IP limiter as the other authenticated
// routes (CodeQL js/missing-rate-limiting).
availabilityRouter.get('/closures', availabilityController.listClosures);

availabilityRouter.get(
  '/admin/closures',
  apiRateLimit,
  authenticate,
  requireRole('admin'),
  availabilityController.listAdminClosures,
);
availabilityRouter.post(
  '/admin/closures',
  apiRateLimit,
  authenticate,
  requireRole('admin'),
  availabilityController.createClosure,
);
availabilityRouter.get(
  '/admin/closures/:closureId',
  apiRateLimit,
  authenticate,
  requireRole('admin'),
  availabilityController.getClosure,
);
availabilityRouter.patch(
  '/admin/closures/:closureId',
  apiRateLimit,
  authenticate,
  requireRole('admin'),
  requireIfMatch,
  availabilityController.updateClosure,
);
availabilityRouter.delete(
  '/admin/closures/:closureId',
  apiRateLimit,
  authenticate,
  requireRole('admin'),
  availabilityController.deleteClosure,
);
