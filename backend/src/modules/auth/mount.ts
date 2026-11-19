import type { Express } from 'express';
import { adminAuthRouter, authRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  app.use('/auth', authRouter);
  // Session administration (Phase 8 #38).
  app.use('/admin', adminAuthRouter);
}
