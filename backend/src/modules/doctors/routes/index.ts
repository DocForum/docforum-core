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
specialtiesRouter.post('/', authenticate, requireRole('admin'), doctorsController.createSpecialty);
specialtiesRouter.patch('/:id', authenticate, requireRole('admin'), doctorsController.updateSpecialty);
specialtiesRouter.post('/:id/retire', authenticate, requireRole('admin'), doctorsController.retireSpecialty);

export const adminDoctorsRouter = Router();
adminDoctorsRouter.get('/doctors/verification-queue', authenticate, requireRole('admin'), doctorsController.verificationQueue);
adminDoctorsRouter.get('/specialties', authenticate, requireRole('admin'), doctorsController.listAdminSpecialties);
adminDoctorsRouter.post('/specialties', authenticate, requireRole('admin'), doctorsController.createSpecialty);
adminDoctorsRouter.patch('/specialties/:id', authenticate, requireRole('admin'), doctorsController.updateSpecialty);
adminDoctorsRouter.post('/specialties/:id/retire', authenticate, requireRole('admin'), doctorsController.retireSpecialty);
