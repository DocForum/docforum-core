import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { errorHandler } from './middleware/error-handler';
import { authRouter } from './modules/auth/routes';
import { doctorsRouter } from './modules/doctors/routes';
import { availabilityRouter } from './modules/availability/routes';
import { appointmentsRouter } from './modules/appointments/routes';

export function createApp() {
  const app = express();

  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  app.use('/auth', authRouter);
  app.use('/doctors', doctorsRouter);
  app.use('/availability', availabilityRouter);
  app.use('/appointments', appointmentsRouter);

  // Must be registered last — Express only routes errors here once every
  // other handler has had a chance to run.
  app.use(errorHandler);

  return app;
}
