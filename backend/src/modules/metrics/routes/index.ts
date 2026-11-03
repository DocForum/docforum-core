import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as metricsController from '../controllers';

export const metricsRouter = Router();
metricsRouter.get('/metrics', authenticate, requireRole('admin'), metricsController.getMetrics);
