import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as adminController from '../controllers/admin';

export const adminOrdersRouter = Router();

adminOrdersRouter.get(
  '/orders/disputes',
  authenticate,
  requireRole('admin'),
  adminController.listDisputes,
);

adminOrdersRouter.post(
  '/orders/disputes/:id/resolve',
  authenticate,
  requireRole('admin'),
  adminController.resolveDispute,
);

export default adminOrdersRouter;
