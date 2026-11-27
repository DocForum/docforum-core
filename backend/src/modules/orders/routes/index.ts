import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import { apiRateLimit } from '../../../middleware/rate-limit';
import * as ordersController from '../controllers';
import { LAB_RESULT_CONTENT_TYPES } from '../services/lab-results';

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

// Issue #16: the result file is the raw request body (one of the accepted
// Content-Types), parsed only after authentication so an anonymous caller
// can't make the server buffer a large upload. Body-parser errors (too large,
// aborted) are mapped to clean 4xx responses instead of the generic 500.
const parseLabResultBody = express.raw({ type: LAB_RESULT_CONTENT_TYPES, limit: config.labResults.maxBytes });
function labResultBody(req: Request, res: Response, next: NextFunction) {
  parseLabResultBody(req, res, (err?: unknown) => {
    if (!err) return next();
    const status = (err as { status?: number }).status;
    if (status === 413) {
      return next(new HttpError('LAB_RESULT_TOO_LARGE', `Result files may be at most ${config.labResults.maxBytes} bytes.`));
    }
    return next(new HttpError('LAB_RESULT_UNREADABLE', 'The result file could not be read.'));
  });
}

ordersRouter.post(
  '/lab-orders/:labOrderId/result',
  authenticate,
  requireRole('facility'),
  labResultBody,
  ordersController.attachLabResult,
);

ordersRouter.get(
  '/lab-orders/:labOrderId/result',
  authenticate,
  ordersController.downloadLabResult,
);

// Issue #11: patient-facing view of active/past orders, supersedes-chain resolved.
// `/mine` before `/:id` so the literal is never captured as an order id.
ordersRouter.get(
  '/mine',
  apiRateLimit,
  authenticate,
  requireRole('patient'),
  ordersController.listMineOrders,
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
