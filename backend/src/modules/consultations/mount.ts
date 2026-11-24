import type { Express } from 'express';
import { appointmentConsultationsRouter, consultationsRouter, followUpsRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  // Closing a consultation is addressable from the appointment it belongs to
  // (POST /appointments/:appointmentId/consultation) as well as from
  // /consultations below — same service, one write path.
  app.use('/appointments', appointmentConsultationsRouter);
  app.use('/consultations', consultationsRouter);
  // Issue #63: follow-up requests are a patient-facing surface of their own.
  app.use('/follow-ups', followUpsRouter);
}
