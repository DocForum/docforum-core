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

// v1 (custodial, admin-triggered — see docs/adr/0004-custodial-payments-v1.md
// "Consequences"): Phase 4/5 (Orders/Fulfillment) don't exist yet, so
// there's no automatic trigger to wire these to. Restricted to admin
// rather than exposed as an open action.
//
// Every money-moving route requires a verified address (Phase 8, issue
// #34) — including the admin-only ones, since an admin account that can't
// receive mail can't complete the account lifecycle (invites, deactivation
// notices) this phase adds either.
paymentsRouter.post('/intents', authenticate, requireRole('admin'), requireVerifiedEmail, paymentsController.createIntent);
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

// SEP-10 Stellar Web Authentication (issue #77, ADR 0005 step 4): prove
// the caller controls a Stellar address before it is ever trusted as a
// payer or payee. Any authenticated role may link a wallet (patient
// wallets become the payer in v2; facility payout wallets replace the
// type-the-address form), so no role gate here — but a VERIFIED address
// is required, same as every other payments mutation in this module
// (issue #34): a wallet link gated only by a possibly-unverified email
// would be a bypass of the guard POST /payments/wallet-link already has.
paymentsRouter.get(
  '/sep10/challenge',
  authenticate,
  requireVerifiedEmail,
  paymentsController.sep10Challenge,
);
paymentsRouter.post(
  '/sep10/verify',
  authenticate,
  requireVerifiedEmail,
  paymentsController.sep10Verify,
);
