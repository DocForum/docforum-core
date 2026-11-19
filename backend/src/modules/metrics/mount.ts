import type { Express } from 'express';
import { metricsRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  app.use('/admin', metricsRouter);
}
