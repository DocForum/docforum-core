import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as controller from '../controllers';

const router = Router();

router.post(
  '/:id/confirm-receipt',
  authenticate,
  requireRole('patient'),
  controller.confirmReceipt
);

router.post(
  '/:id/dispute',
  authenticate,
  requireRole('patient'),
  controller.disputeOrder
);

router.get(
  '/:id',
  authenticate,
  controller.getOrder
);

export default router;
