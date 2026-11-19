import type { Express } from 'express';
import { paymentsRouter } from './routes';
import { escrowEventsRouter } from './routes/escrow-events';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  app.use('/payments', paymentsRouter);
  app.use('/admin/payments', escrowEventsRouter);
}
