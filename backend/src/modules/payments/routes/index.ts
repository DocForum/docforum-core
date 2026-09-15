import { Router } from 'express';
import { authenticate, requireRole } from '../../../middleware/auth';
import * as paymentsController from '../controllers';

export const paymentsRouter = Router();

// Facility manages its own payout wallet.
paymentsRouter.post('/wallet-link', authenticate, requireRole('facility'), paymentsController.linkWallet);
paymentsRouter.get('/wallet-link', authenticate, requireRole('facility'), paymentsController.getOwnWallet);

// v1 (custodial, admin-triggered — see docs/adr/0004-custodial-payments-v1.md
// "Consequences"): Phase 4/5 (Orders/Fulfillment) don't exist yet, so
// there's no automatic trigger to wire these to. Restricted to admin
// rather than exposed as an open action.
paymentsRouter.post('/intents', authenticate, requireRole('admin'), paymentsController.createIntent);
paymentsRouter.get('/intents/:id', authenticate, requireRole('admin'), paymentsController.getIntent);
paymentsRouter.post('/intents/:id/fund', authenticate, requireRole('admin'), paymentsController.fundIntent);
paymentsRouter.post('/intents/:id/release', authenticate, requireRole('admin'), paymentsController.releaseIntent);
paymentsRouter.post('/intents/:id/refund', authenticate, requireRole('admin'), paymentsController.refundIntent);
