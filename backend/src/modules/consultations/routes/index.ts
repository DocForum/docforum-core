import { Router } from 'express';
import { authenticate, requireRole, requireVerifiedEmail } from '../../../middleware/auth';
import * as consultationsController from '../controllers';

/**
 * Appointment-scoped router. Mounted at /appointments in src/app.ts, so the
 * full path is POST /appointments/:appointmentId/consultation. It is a
 * separate router from `consultationsRouter` because this module's other
 * routes live under /consultations — mounting one router at both prefixes
 * would also publish `/appointments/:consultationId`.
 *
 * Closing is doctor-only and restricted to the doctor's own appointment via
 * the service layer; the one-per-appointment guarantee is enforced at the DB
 * level (`Consultation.appointmentId UNIQUE`). Verified-address bar, same as
 * booking and the create route below — closing a consultation is what
 * referrals and orders hang off.
 */
export const appointmentConsultationsRouter = Router();

appointmentConsultationsRouter.post(
  '/:appointmentId/consultation',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  consultationsController.closeConsultation,
);

/** Mounted at /consultations. */
export const consultationsRouter = Router();

consultationsRouter.get(
  '/mine',
  authenticate,
  requireRole('patient'),
  consultationsController.listMine,
);
consultationsRouter.get(
  '/doctor',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  consultationsController.listDoctor,
);
consultationsRouter.post(
  '/',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  consultationsController.create,
);
consultationsRouter.get('/:consultationId', authenticate, consultationsController.getOne);

// --- Issue #62: signed attachment download --------------------------------
// The signed file endpoint is registered before the thread routes so it is
// obvious that it deliberately carries no auth middleware — the signature is
// the authorisation. `download-url` itself is authenticated and re-checks
// thread membership on every call.
consultationsRouter.get(
  '/messages/attachments/:attachmentId/download-url',
  authenticate,
  consultationsController.attachmentDownloadUrl,
);
consultationsRouter.get(
  '/messages/attachments/:attachmentId/file',
  consultationsController.downloadAttachmentFile,
);

// --- Issue #61/#62: async consultation thread -----------------------------
consultationsRouter.get(
  '/:consultationId/messages',
  authenticate,
  consultationsController.listMessages,
);
consultationsRouter.post(
  '/:consultationId/messages',
  authenticate,
  requireVerifiedEmail,
  consultationsController.postMessage,
);

// --- Issue #64: note sign-off + append-only addenda -----------------------
consultationsRouter.patch(
  '/:consultationId/notes',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  consultationsController.updateNotes,
);
consultationsRouter.post(
  '/:consultationId/sign-off',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  consultationsController.signOff,
);
consultationsRouter.post(
  '/:consultationId/addenda',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  consultationsController.addAddendum,
);

// Issue #66 (PRD §8.2.4): multiple simultaneous referrals from one
// consultation, atomic all-or-none, each with its own snapshot copy.
consultationsRouter.post(
  '/:consultationId/referrals',
  authenticate,
  requireRole('doctor'),
  requireVerifiedEmail,
  consultationsController.createReferrals,
);

/** Issue #63: the patient's own follow-up requests. Mounted at /follow-ups. */
export const followUpsRouter = Router();

followUpsRouter.get('/mine', authenticate, requireRole('patient'), consultationsController.listMyFollowUps);
followUpsRouter.post(
  '/:followUpId/book',
  authenticate,
  requireRole('patient'),
  requireVerifiedEmail,
  consultationsController.bookFollowUp,
);
