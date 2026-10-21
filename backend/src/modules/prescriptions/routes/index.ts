import { Router } from 'express';
import { authenticate } from '../../../middleware/auth';
import * as prescriptionsController from '../controllers';

export const prescriptionsRouter = Router();

prescriptionsRouter.get('/:id', authenticate, prescriptionsController.getPrescription);
prescriptionsRouter.get('/', authenticate, prescriptionsController.listPrescriptions);