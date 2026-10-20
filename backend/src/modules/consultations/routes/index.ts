import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import * as consultationsController from '../controllers';

/**
 * Appointment-scoped router. Mounted at /appointments in src/app.ts, so the
 * full path is POST /appointments/:appointmentId/consultation. It is a
 * separate router from `consultationsRouter` because this module's other
 * routes live under /consultations — mounting one router at both prefixes
 * would also publish `/appointments/:consultationId`.
 *
 * Closing is doctor-only and restricted to the doctor's own appointment via
 * the service layer; the one-per-appointment guarantee is enforced at the DB
 * level (`Consultation.appointmentId UNIQUE`). Verified-address bar, same as
 * booking and the create route below — closing a consultation is what
 * referrals and orders hang off.
 */
export const appointmentConsultationsRouter = Router();

appointmentConsultationsRouter.post(
  '/:appointmentId/consultation',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  consultationsController.closeConsultation,
);

/** Mounted at /consultations. */
export const consultationsRouter = Router();

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
