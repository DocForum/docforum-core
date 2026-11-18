import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as intakeController from '../controllers';

export const intakeRouter = Router();

intakeRouter.post('/', authenticate, requireRole('patient'), intakeController.create);
intakeRouter.get('/mine', authenticate, requireRole('patient'), intakeController.listMine);
