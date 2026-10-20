import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as consultationsController from '../controllers';

export const consultationsRouter = Router();

// Doctor-only in v1: the authoring doctor is the only account wired to these
// (see the flagged limitation in services/index.ts). Patient access to their
// own care thread follows the appointment link that issue #4 owns — not
// invented here.
consultationsRouter.post('/', authenticate, requireRole('doctor'), consultationsController.create);
consultationsRouter.get('/:id', authenticate, requireRole('doctor'), consultationsController.get);
consultationsRouter.patch('/:id', authenticate, requireRole('doctor'), consultationsController.update);
consultationsRouter.post('/:id/sign-off', authenticate, requireRole('doctor'), consultationsController.signOff);
consultationsRouter.post('/:id/addenda', authenticate, requireRole('doctor'), consultationsController.addAddendum);
// Issue #66 (PRD §8.2.4): multiple simultaneous referrals from one
// consultation, atomic all-or-none, each with its own snapshot copy.
consultationsRouter.post(
  '/:consultationId/referrals',
  authenticate,
  requireRole('doctor'),
  consultationsController.createReferrals,
);
