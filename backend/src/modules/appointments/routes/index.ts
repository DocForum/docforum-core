import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import * as appointmentsController from '../controllers';

export const appointmentsRouter = Router();

// Booking is a mutation against someone else's calendar, and the patient
// gets notifications about it — so it requires a verified address
// (Phase 8, issue #34). Browsing (`GET /availability/...`) stays open.
appointmentsRouter.post(
  '/',
  authenticate,
  requireRole('patient'),
  requireVerifiedEmail,
  appointmentsController.book,
);
appointmentsRouter.get('/mine', authenticate, requireRole('patient'), appointmentsController.listMine);
