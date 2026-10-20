import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import * as paymentsController from '../controllers';

export const paymentsRouter = Router();

// Facility manages its own payout wallet.
paymentsRouter.post(
  '/wallet-link',
  authenticate,
  requireRole('facility'),
  requireVerifiedEmail,
  paymentsController.linkWallet,
);
paymentsRouter.get('/wallet-link', authenticate, requireRole('facility'), paymentsController.getOwnWallet);

paymentsRouter.get('/intents/:id', authenticate, requireRole('admin'), paymentsController.getIntent);
paymentsRouter.post(
  '/intents/:id/fund',
  authenticate,
  requireRole('admin'),
  requireVerifiedEmail,
  paymentsController.fundIntent,
);
paymentsRouter.post(
  '/intents/:id/release',
  authenticate,
  requireRole('admin'),
  requireVerifiedEmail,
  paymentsController.releaseIntent,
);
paymentsRouter.post(
  '/intents/:id/refund',
  authenticate,
  requireRole('admin'),
  requireVerifiedEmail,
  paymentsController.refundIntent,
);
