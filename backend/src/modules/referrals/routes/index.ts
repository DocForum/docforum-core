import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import * as referralsController from '../controllers';

export const referralsRouter = Router();

// Creating a referral hands a patient to another doctor with clinical
// context attached, and accepting one books a real slot — both are
// mutations that need a trustworthy contact address, same bar as booking
// itself (Phase 8, issue #34's guard).
referralsRouter.post(
  '/',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  referralsController.create,
);
// Multiple simultaneous referrals from ONE consultation (issue #66, PRD
// §8.2.4) — atomic all-or-none batch, same guard rails as the single
// create above. Mounted here rather than in consultations/ so the whole
// referral write surface stays in this module; consultations' own routes
// live in their module.
referralsRouter.post(
  '/from-consultation/:consultationId',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  referralsController.createBatch,
);
referralsRouter.post(
  '/:referralId/accept',
  authenticate,
  requireRole('patient'),
  requireVerifiedEmail,
  referralsController.accept,
);
referralsRouter.post(
  '/:referralId/decline',
  authenticate,
  requireRole('patient'),
  requireVerifiedEmail,
  referralsController.decline,
);
referralsRouter.get('/mine', authenticate, requireRole('patient'), referralsController.listMine);
// Referring doctors see the referrals they created — including ones the
// cascade expired after repeated no-shows (referringDoctorNotifiedAt) and
// ones the loop guard flagged.
referralsRouter.get('/created', authenticate, requireRole('doctor'), referralsController.listCreated);

// Admin operations (issue #68). The queue doubles as the loop-detection
// admin view (#65) via ?loopFlagged=true.
referralsRouter.get(
  '/admin/queue',
  authenticate,
  requireRole('admin'),
  referralsController.adminQueue,
);
referralsRouter.post(
  '/admin/:referralId/reassign',
  authenticate,
  requireRole('admin'),
  referralsController.adminReassign,
);
referralsRouter.post(
  '/admin/:referralId/cancel',
  authenticate,
  requireRole('admin'),
  referralsController.adminCancel,
);
referralsRouter.get(
  '/admin/:referralId/audit-events',
  authenticate,
  requireRole('admin'),
  referralsController.auditTrail,
);
