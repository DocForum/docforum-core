import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import * as consultationsController from '../controllers';

export const consultationsRouter = Router();

// Recording a consultation and spawning referrals from it both hand a
// patient onward with clinical context — verified-address bar, same as
// booking and referral creation itself.
consultationsRouter.post(
  '/',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  consultationsController.create,
);
consultationsRouter.get('/:consultationId', authenticate, consultationsController.getOne);
// Issue #66 (PRD §8.2.4): multiple simultaneous referrals from one
// consultation, atomic all-or-none, each with its own snapshot copy.
consultationsRouter.post(
  '/:consultationId/referrals',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  consultationsController.createReferrals,
);
