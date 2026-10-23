import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { errorHandler } from './middleware/error-handler';
import { adminAuthRouter, authRouter } from './modules/auth/routes';
import { doctorsRouter, specialtiesRouter } from './modules/doctors/routes';
import { availabilityRouter } from './modules/availability/routes';
import { appointmentsRouter } from './modules/appointments/routes';
import { appointmentConsultationsRouter, consultationsRouter } from './modules/consultations/routes';
import { ordersRouter } from './modules/orders/routes';
import { adminOrdersRouter } from './modules/orders/routes/admin';
import { pharmacyOrdersRouter } from './modules/pharmacy-orders/routes';
import { labOrdersRouter } from './modules/lab-orders/routes';
import { paymentsRouter } from './modules/payments/routes';
import { patientsRouter } from './modules/patients/routes';
import { facilitiesRouter } from './modules/facilities/routes';
import { adminRouter } from './modules/users/routes';
import { registerPatientExportSections } from './export-sections';
import { auditRouter, adminAuditRouter, patientAuditRouter } from './modules/audit/routes';
import { escrowEventsRouter } from './modules/payments/routes/escrow-events';
import { requestId } from './middleware/request-id';
import { referralsRouter } from './modules/referrals/routes';
import { notificationsRouter } from './modules/notifications/routes';
import { registerRetentionHolds } from './retention-holds';

export function createApp() {
  const app = express();

  // Phase 8, issue #40: idempotent, so building the app twice is harmless.
  registerPatientExportSections();
  // Phase 8, issue #41: idempotent, so building the app twice is harmless.
  registerRetentionHolds();

  // Phase 8, issue #35: login throttling keys on the client IP, so the
  // proxy chain has to be resolved deliberately rather than guessed. See
  // config.trustProxy for why neither `true` nor the default is safe here.
  app.set('trust proxy', config.trustProxy);

  // Explicit allowlist per environment (Phase 8, issue #37) — see
  // config.corsOrigins. `credentials: true` is required for the refresh
  // cookie and is exactly why the allowlist can't be a wildcard.
  // Phase 8, issue #43: first, so every response (errors included) carries
  // an X-Request-Id and audit events can be tied back to it. Phase 9,
  // issue #46: the same middleware attaches a request-scoped child logger
  // (`req.log`) so every log line in a request can be greped by that id.
  app.use(requestId);
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  app.use('/auth', authRouter);
  // Admin surface. Currently only the auth module's session administration
  // (Phase 8 #38) — other modules' admin routes can hang off the same mount.
  app.use('/admin', adminAuthRouter);
  app.use('/doctors', doctorsRouter);
  app.use('/specialties', specialtiesRouter);
  app.use('/availability', availabilityRouter);
  app.use('/appointments', appointmentsRouter);
  // Closing a consultation is addressable from the appointment it belongs to
  // (POST /appointments/:appointmentId/consultation) as well as from
  // /consultations below — same service, one write path.
  app.use('/appointments', appointmentConsultationsRouter);
  app.use('/orders', ordersRouter);
  app.use('/pharmacy-orders', pharmacyOrdersRouter);
  app.use('/lab-orders', labOrdersRouter);
  app.use('/admin', adminOrdersRouter);
  app.use('/payments', paymentsRouter);
  app.use('/patients', patientsRouter);
  app.use('/facilities', facilitiesRouter);
  // Phase 8, issue #39 — admin account lifecycle (invites, deactivate/
  // reactivate) alongside the audit read path. Different paths, no overlap.
  app.use('/admin', adminRouter);
  app.use('/admin', auditRouter);
  app.use('/admin/payments', escrowEventsRouter);

  // PHI read-access logging (Phase 8, issue #45). Mounted at root so the
  // paths match the issue's spec exactly: /admin/access-logs, /patients/me/access-log.
  app.use('/admin', adminAuditRouter);
  app.use('/patients', patientAuditRouter);
  app.use('/referrals', referralsRouter);
  app.use('/notifications', notificationsRouter);
  app.use('/consultations', consultationsRouter);

  // Must be registered last — Express only routes errors here once every
  // other handler has had a chance to run.
  app.use(errorHandler);

  return app;
}
