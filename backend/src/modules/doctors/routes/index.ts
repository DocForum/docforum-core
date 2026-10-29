import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import { requireIfMatch } from '../../../middleware/optimistic-concurrency';
import * as doctorsController from '../controllers';

export const doctorsRouter = Router();

doctorsRouter.get('/', doctorsController.listPublic);
doctorsRouter.get('/me', authenticate, requireRole('doctor'), doctorsController.getMe);
doctorsRouter.patch('/me', authenticate, requireRole('doctor'), requireIfMatch, doctorsController.updateMe);
doctorsRouter.put('/me/specialties', authenticate, requireRole('doctor'), doctorsController.setMySpecialties);
doctorsRouter.patch(
  '/:doctorProfileId/verification',
  authenticate,
  requireRole('admin'),
  doctorsController.setVerification,
);

doctorsRouter.patch(
  '/:doctorProfileId/specialties/:specialtyId/verification',
  authenticate,
  requireRole('admin'),
  doctorsController.setDoctorSpecialtyVerification,
);

export const specialtiesRouter = Router();
specialtiesRouter.get('/', doctorsController.listSpecialties);
