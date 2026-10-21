import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import * as paymentsController from '../controllers';

export const paymentsRouter = Router();

paymentsRouter.get('/mine', authenticate, requireRole('patient'), paymentsController.listMyPayments);
paymentsRouter.get('/facility/ledger', authenticate, requireRole('facility'), paymentsController.listFacilityLedger);

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

// ADR 0005 step 2 (issue #80) — the patient prepares their own intent for
// signing. Ownership is enforced in the service (not merely by the role),
// and someone else's intent is a 404 rather than a 403. Money does not move
// in this call, but it is the first half of a payment, so it sits behind
// the same verified-email gate as fund.
paymentsRouter.post(
  '/intents/:id/prepare',
  authenticate,
  requireRole('patient'),
  requireVerifiedEmail,
  paymentsController.prepareIntent,
);
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
