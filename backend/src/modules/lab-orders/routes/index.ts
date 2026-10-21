import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as labOrdersController from '../controllers';

export const labOrdersRouter = Router();

labOrdersRouter.get('/:id', authenticate, labOrdersController.getLabOrder);
labOrdersRouter.get('/', authenticate, labOrdersController.listLabOrders);

// Facility endpoints
labOrdersRouter.post('/:id/result', authenticate, requireRole('facility'), labOrdersController.attachLabResult);

// Doctor endpoints
labOrdersRouter.post('/results/:id/acknowledge', authenticate, requireRole('doctor'), labOrdersController.acknowledgeLabResult);
labOrdersRouter.get('/results/unacknowledged', authenticate, requireRole('doctor'), labOrdersController.getUnacknowledgedResults);