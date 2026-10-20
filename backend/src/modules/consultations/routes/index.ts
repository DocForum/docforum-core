import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as consultationsController from '../controllers';

export const consultationsRouter = Router();

// Close (create) a consultation for an appointment. Doctor-only and restricted
// to the doctor's own appointment via the service layer; the one-per-appointment
// guarantee is enforced at the DB level (`Consultation.appointmentId UNIQUE`).
// Mounted at /appointments in src/app.ts, so the full path is
// POST /appointments/:appointmentId/consultation.
consultationsRouter.post(
  '/:appointmentId/consultation',
  authenticate,
  requireRole('doctor'),
  consultationsController.closeConsultation,
);
