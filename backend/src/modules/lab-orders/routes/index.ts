import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import { apiRateLimit } from '../../../middleware/rate-limit';
import * as controllers from '../controllers';

export const labOrdersRouter = Router();

labOrdersRouter.post('/', authenticate, controllers.createLabOrder);
labOrdersRouter.get('/:id', apiRateLimit, authenticate, controllers.getLabOrder);
labOrdersRouter.post('/:id/fulfill', authenticate, requireRole('facility'), controllers.fulfillLabOrder);
