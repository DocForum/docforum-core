import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as controllers from '../controllers';

export const pharmacyOrdersRouter = Router();

pharmacyOrdersRouter.post('/', authenticate, controllers.createPharmacyOrder);
pharmacyOrdersRouter.get('/:id', authenticate, controllers.getPharmacyOrder);
pharmacyOrdersRouter.post('/:id/fulfill', authenticate, requireRole('facility'), controllers.fulfillPharmacyOrder);
