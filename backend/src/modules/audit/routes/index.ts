import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as auditController from '../controllers';

export const auditRouter = Router();

// Phase 8, issue #43 — admin-only, read-only. There is no write route: events
// are only ever created by record() inside the transaction they describe.
auditRouter.get('/audit-events', authenticate, requireRole('admin'), auditController.listAuditEvents);

// Phase 8, issue #45 — PHI read-access log. Separate routers because the
// two audiences have genuinely different shapes: the admin queries keep
// viewer ids for attribution, the patient one strips all viewer PII down
// to a role. Mounted in app.ts at /admin and /patients respectively.
export const adminAuditRouter = Router();

// No write routes: rows are only ever written by recordAccess() off the
// read path. Order matters only between overlapping paths — here the
// stats route is a sub-path of the collection and must be listed first.
adminAuditRouter.get('/access-logs/stats', authenticate, requireRole('admin'), auditController.accessLogStats);
adminAuditRouter.get('/access-logs', authenticate, requireRole('admin'), auditController.listAccessLogsByEntity);
adminAuditRouter.get('/access-logs/user', authenticate, requireRole('admin'), auditController.listAccessLogsByUser);

export const patientAuditRouter = Router();

// Scoped server-side to the caller's own patient profile — the profile id
// is resolved from the authenticated user, never from the request.
patientAuditRouter.get('/me/access-log', authenticate, requireRole('patient'), auditController.myAccessLog);
