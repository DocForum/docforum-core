import type { Express } from 'express';
import { patientsRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  app.use('/patients', patientsRouter);
}
