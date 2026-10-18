import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as auditController from '../controllers';

export const auditRouter = Router();

// Phase 8, issue #43 — admin-only, read-only. There is no write route: events
// are only ever created by record() inside the transaction they describe.
auditRouter.get('/audit-events', authenticate, requireRole('admin'), auditController.listAuditEvents);
