import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as patientsController from '../controllers';

export const patientsRouter = Router();

// Account deletion (Phase 8, issue #41, docs/adr/0007). Self-only — the
// account is the authenticated caller, never a path or body parameter.
// Deliberately not behind requireVerifiedEmail: an unverified account must
// still be deletable.
patientsRouter.delete('/me', authenticate, requireRole('patient'), patientsController.deleteMe);
