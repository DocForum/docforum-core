import type { Express } from 'express';
import { availabilityRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  app.use('/availability', availabilityRouter);
}
