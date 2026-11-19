import type { Express } from 'express';
import { adminFlagsRouter, meFlagsRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  // Feature flags (Phase 8, issue #132).
  app.use('/me', meFlagsRouter);
  app.use('/admin', adminFlagsRouter);
}
