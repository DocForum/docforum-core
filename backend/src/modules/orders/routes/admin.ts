import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as adminController from '../controllers/admin';

const router = Router();

router.get(
  '/disputes',
  authenticate,
  requireRole('admin'),
  adminController.listDisputes
);

router.post(
  '/disputes/:id/resolve',
  authenticate,
  requireRole('admin'),
  adminController.resolveDispute
);

export default router;
