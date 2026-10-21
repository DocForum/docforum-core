import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as doctorsController from '../controllers';

export const doctorsRouter = Router();

doctorsRouter.get('/', doctorsController.listPublic);
doctorsRouter.get('/me', authenticate, requireRole('doctor'), doctorsController.getMe);
doctorsRouter.put('/me/specialties', authenticate, requireRole('doctor'), doctorsController.setMySpecialties);
doctorsRouter.patch(
  '/:doctorProfileId/verification',
  authenticate,
  requireRole('admin'),
  doctorsController.setVerification,
);

export const specialtiesRouter = Router();
specialtiesRouter.get('/', doctorsController.listSpecialties);
