import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import * as ordersController from '../controllers';

export const ordersRouter = Router();

ordersRouter.post(
  '/consultations',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  ordersController.createConsultation,
);

ordersRouter.post(
  '/consultations/:consultationId/prescriptions',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  ordersController.issuePrescription,
);

ordersRouter.post(
  '/consultations/:consultationId/lab-orders',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  ordersController.issueLabOrder,
);

ordersRouter.post(
  '/:id/confirm-receipt',
  authenticate,
  requireRole('patient'),
  ordersController.confirmReceipt,
);

ordersRouter.post(
  '/:id/dispute',
  authenticate,
  requireRole('patient'),
  ordersController.disputeOrder,
);

ordersRouter.get(
  '/:id',
  authenticate,
  ordersController.getOrder,
);

export default ordersRouter;
