import type { Express } from 'express';
import { referralsRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  app.use('/referrals', referralsRouter);
}
