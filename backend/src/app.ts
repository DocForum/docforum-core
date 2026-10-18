import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { errorHandler } from './middleware/error-handler';
import { authRouter } from './modules/auth/routes';
import { doctorsRouter } from './modules/doctors/routes';
import { availabilityRouter } from './modules/availability/routes';
import { appointmentsRouter } from './modules/appointments/routes';
import { paymentsRouter } from './modules/payments/routes';
import { auditRouter } from './modules/audit/routes';
import { requestId } from './middleware/request-id';

export function createApp() {
  const app = express();

  // Phase 8, issue #35: login throttling keys on the client IP, so the
  // proxy chain has to be resolved deliberately rather than guessed. See
  // config.trustProxy for why neither `true` nor the default is safe here.
  app.set('trust proxy', config.trustProxy);

  // Explicit allowlist per environment (Phase 8, issue #37) — see
  // config.corsOrigins. `credentials: true` is required for the refresh
  // cookie and is exactly why the allowlist can't be a wildcard.
  // Phase 8, issue #43: first, so every response (errors included) carries
  // an X-Request-Id and audit events can be tied back to it.
  app.use(requestId);
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  app.use('/auth', authRouter);
  app.use('/doctors', doctorsRouter);
  app.use('/availability', availabilityRouter);
  app.use('/appointments', appointmentsRouter);
  app.use('/payments', paymentsRouter);
  app.use('/admin', auditRouter);

  // Must be registered last — Express only routes errors here once every
  // other handler has had a chance to run.
  app.use(errorHandler);

  return app;
}
