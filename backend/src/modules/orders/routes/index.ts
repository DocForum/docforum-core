import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as controllers from '../controllers';

export const ordersRouter = Router();

ordersRouter.get('/:id', authenticate, controllers.getOrder);
ordersRouter.post('/:id/confirm-receipt', authenticate, requireRole('patient'), controllers.confirmReceipt);
ordersRouter.post('/:id/dispute', authenticate, requireRole('patient'), controllers.disputeOrder);
