import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import * as ordersController from '../controllers';

// Issue #72 (PRD §8.2.7): abnormal/critical results are acknowledged by the
// ordering doctor and escalated to the admin queue when they are not.
// Deliberately mounted at /lab-results (not under /orders) because the task is
// addressed by its own LabResult id, and the contract agreed in the issue uses
// POST /lab-results/:id/acknowledge.
export const labResultsRouter = Router();

// Doctor: their own outstanding tasks. Admin: the escalation queue (overdue or
// already escalated). Patients never see this list — they read their own
// result through GET /orders/lab-orders/:labOrderId/result.
labResultsRouter.get(
  '/unacknowledged',
  authenticate,
  requireRole('doctor', 'admin'),
  ordersController.listUnacknowledgedLabResults,
);

labResultsRouter.post(
  '/:labResultId/acknowledge',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  ordersController.acknowledgeLabResult,
);

export default labResultsRouter;
