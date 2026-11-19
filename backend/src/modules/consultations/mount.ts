import type { Express } from 'express';
import { appointmentConsultationsRouter, consultationsRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  // Closing a consultation is addressable from the appointment it belongs to
  // (POST /appointments/:appointmentId/consultation) as well as from
  // /consultations below — same service, one write path.
  app.use('/appointments', appointmentConsultationsRouter);
  app.use('/consultations', consultationsRouter);
}
