// audit routes — read-side of the PHI access log (issue #45).
//
// The issue specifies two endpoints:
//   GET /admin/access-logs?entityId=...   (admin)
//   GET /patients/me/access-log           (patient, own records only)
//
// These are mounted at app root (not under /audit) to match the issue's
// specified paths exactly.
import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as auditController from '../controllers';

export const adminAuditRouter = Router();
export const patientAuditRouter = Router();

// Admin read-side: entity-scoped access logs, user-scoped logs, and
// failure stats for alerting. All gated to admin — the log itself
// reveals who viewed what.
adminAuditRouter.get('/access-logs', authenticate, requireRole('admin'), auditController.getAccessLogsByEntity);
adminAuditRouter.get('/access-logs/user', authenticate, requireRole('admin'), auditController.getAccessLogsByUser);
adminAuditRouter.get('/access-logs/stats', authenticate, requireRole('admin'), auditController.getAccessLogStats);

// Patient read-side: who viewed MY records. Scoped server-side to the
// caller's own patientProfileId — never client-supplied.
patientAuditRouter.get('/me/access-log', authenticate, requireRole('patient'), auditController.getMyAccessLog);
