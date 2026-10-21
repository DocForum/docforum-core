import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import * as paymentsController from '../controllers';

export const paymentsRouter = Router();

// Wallet links (issue #78): patients link the wallet they pay FROM
// (ADR 0005 v2 payer), facilities the wallet they are paid TO. Only
// these two roles can own a link — resolved to the caller's OWN profile
// in the service, so linking for an owner you don't control is a 403.
//
// The body is a signed SEP-10 challenge, never an address (see
// validation.ts); still verified-email-gated like every payments
// mutation here (issue #34 — and ADR 0005's replacement for the old
// typed-in endpoint, which was gated the same way).
paymentsRouter.post(
  '/wallet-link',
  authenticate,
  requireRole('patient', 'facility'),
  requireVerifiedEmail,
  paymentsController.linkWallet,
);
paymentsRouter.get(
  '/wallet-link',
  authenticate,
  requireRole('patient', 'facility'),
  paymentsController.getOwnWallet,
);

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
