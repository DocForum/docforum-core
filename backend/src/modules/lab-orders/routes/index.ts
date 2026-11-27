import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import { apiRateLimit } from '../../../middleware/rate-limit';
import * as controllers from '../controllers';

export const labOrdersRouter = Router();

// Legacy `Order` creation: admin-only (see pharmacy-orders/routes).
labOrdersRouter.post('/', apiRateLimit, authenticate, requireRole('admin'), controllers.createLabOrder);
labOrdersRouter.get('/:id', apiRateLimit, authenticate, controllers.getLabOrder);
labOrdersRouter.post('/:id/fulfill', apiRateLimit, authenticate, requireRole('facility'), controllers.fulfillLabOrder);
