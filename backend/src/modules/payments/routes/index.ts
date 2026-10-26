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
