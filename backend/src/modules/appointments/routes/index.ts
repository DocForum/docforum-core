import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as appointmentsController from '../controllers';

export const appointmentsRouter = Router();

appointmentsRouter.post('/', authenticate, requireRole('patient'), appointmentsController.book);
appointmentsRouter.get('/mine', authenticate, requireRole('patient'), appointmentsController.listMine);
