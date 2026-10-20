import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import * as ordersController from '../controllers';
export const ordersRouter = Router();
ordersRouter.post('/consultations', authenticate, requireRole('doctor'), requireVerifiedEmail, ordersController.createConsultation);
ordersRouter.post('/consultations/:consultationId/prescriptions', authenticate, requireRole('doctor'), requireVerifiedEmail, ordersController.issuePrescription);
ordersRouter.post('/consultations/:consultationId/lab-orders', authenticate, requireRole('doctor'), requireVerifiedEmail, ordersController.issueLabOrder);