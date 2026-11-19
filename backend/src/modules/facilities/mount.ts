import type { Express } from 'express';
import { facilitiesRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  // Phase 5 (issues #73/#74).
  app.use('/facilities', facilitiesRouter);
}
