import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import { requireIfMatch } from '../../../middleware/optimistic-concurrency';
import { apiRateLimit } from '../../../middleware/rate-limit';
import * as doctorsController from '../controllers';

export const doctorsRouter = Router();

doctorsRouter.get('/', doctorsController.listPublic);
doctorsRouter.get('/me', authenticate, requireRole('doctor'), doctorsController.getMe);
doctorsRouter.patch('/me', authenticate, requireRole('doctor'), requireIfMatch, doctorsController.updateMe);
doctorsRouter.post(
  '/me/calendar-feed',
  apiRateLimit,
  authenticate,
  requireRole('doctor'),
  doctorsController.rotateCalendarFeed,
);
doctorsRouter.delete(
  '/me/calendar-feed',
  apiRateLimit,
  authenticate,
  requireRole('doctor'),
  doctorsController.revokeCalendarFeed,
);
doctorsRouter.put('/me/specialties', authenticate, requireRole('doctor'), doctorsController.setMySpecialties);
doctorsRouter.get('/:doctorProfileId', doctorsController.getPublicDoctor);
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

// Issue #60: public symptom vocabulary (autocomplete for "search by
// symptom"). Declaration order matters — keep it last, and note the
// doctors router's `/:doctorProfileId` does not apply here: this is a
// separate mount (`/symptoms`, see mount.ts).
export const symptomsRouter = Router();
symptomsRouter.get('/', doctorsController.listSymptoms);

export const adminDoctorsRouter = Router();
adminDoctorsRouter.get('/doctors/verification-queue', authenticate, requireRole('admin'), doctorsController.verificationQueue);
adminDoctorsRouter.get('/symptoms', authenticate, requireRole('admin'), doctorsController.listAdminSymptoms);
adminDoctorsRouter.post('/symptoms', authenticate, requireRole('admin'), doctorsController.createSymptom);
adminDoctorsRouter.patch('/symptoms/:id', authenticate, requireRole('admin'), doctorsController.updateSymptom);
adminDoctorsRouter.put(
  '/symptoms/:id/specialties',
  authenticate,
  requireRole('admin'),
  doctorsController.setSymptomSpecialties,
);
adminDoctorsRouter.get('/specialties', authenticate, requireRole('admin'), doctorsController.listAdminSpecialties);
adminDoctorsRouter.post('/specialties', authenticate, requireRole('admin'), doctorsController.createSpecialty);
adminDoctorsRouter.patch('/specialties/:id', authenticate, requireRole('admin'), doctorsController.updateSpecialty);
adminDoctorsRouter.post('/specialties/:id/retire', authenticate, requireRole('admin'), doctorsController.retireSpecialty);
