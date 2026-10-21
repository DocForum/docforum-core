import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as patientsController from '../controllers';

export const patientsRouter = Router();

// Patient data export (Phase 8, issue #40). Patient-only and self-only:
// doctors and admins get 403 here, and an export id that belongs to another
// patient is a 404. There is no admin-on-behalf-of route.
patientsRouter.post('/me/export', authenticate, requireRole('patient'), patientsController.requestExport);
patientsRouter.get('/me/export/:exportId', authenticate, requireRole('patient'), patientsController.getExport);
patientsRouter.get(
  '/me/export/:exportId/download',
  authenticate,
  requireRole('patient'),
  patientsController.downloadExport,
);
// Account deletion (Phase 8, issue #41, docs/adr/0010). Self-only — the
// account is the authenticated caller, never a path or body parameter.
// Deliberately not behind requireVerifiedEmail: an unverified account must
// still be deletable.
patientsRouter.delete('/me', authenticate, requireRole('patient'), patientsController.deleteMe);
