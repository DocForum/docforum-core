import type { Express } from 'express';
import { appointmentsRouter, calendarRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  app.use('/appointments', appointmentsRouter);
  app.use('/calendar', calendarRouter);
}
