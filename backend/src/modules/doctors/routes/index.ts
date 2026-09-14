import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as doctorsController from '../controllers';

export const doctorsRouter = Router();

doctorsRouter.get('/me', authenticate, requireRole('doctor'), doctorsController.getMe);
doctorsRouter.patch(
  '/:doctorProfileId/verification',
  authenticate,
  requireRole('admin'),
  doctorsController.setVerification,
);
