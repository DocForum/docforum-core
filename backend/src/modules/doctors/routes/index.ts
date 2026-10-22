import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as doctorsController from '../controllers';

export const doctorsRouter = Router();

doctorsRouter.get('/', doctorsController.listPublic);
doctorsRouter.get('/me', authenticate, requireRole('doctor'), doctorsController.getMe);
doctorsRouter.put('/me/specialties', authenticate, requireRole('doctor'), doctorsController.setMySpecialties);
doctorsRouter.post('/me/calendar-token', authenticate, requireRole('doctor'), doctorsController.rotateMyCalendarToken);
doctorsRouter.delete('/me/calendar-token', authenticate, requireRole('doctor'), doctorsController.revokeMyCalendarToken);
doctorsRouter.get('/:doctorProfileId/calendar-token', authenticate, requireRole('doctor'), doctorsController.getMyCalendarToken);
doctorsRouter.patch(
  '/:doctorProfileId/verification',
  authenticate,
  requireRole('admin'),
  doctorsController.setVerification,
);

export const specialtiesRouter = Router();
specialtiesRouter.get('/', doctorsController.listSpecialties);
