import type { Express } from 'express';
import { adminRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  // Phase 8, issue #39 — admin account lifecycle (invites, deactivate/
  // reactivate). Its router authenticates and requires the admin role for
  // every /admin request it sees; every /admin route is admin-only anyway.
  app.use('/admin', adminRouter);
}
