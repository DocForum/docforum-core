import type { Express } from 'express';
import { medicationsRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  // Issue #69: controlled medication vocabulary.
  app.use('/medications', medicationsRouter);
}
