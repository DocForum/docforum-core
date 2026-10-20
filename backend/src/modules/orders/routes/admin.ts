import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as adminControllers from '../controllers/admin';

export const adminOrdersRouter = Router();

adminOrdersRouter.get('/orders/disputes', authenticate, requireRole('admin'), adminControllers.listDisputes);
adminOrdersRouter.post('/orders/disputes/:id/resolve', authenticate, requireRole('admin'), adminControllers.resolveDispute);
