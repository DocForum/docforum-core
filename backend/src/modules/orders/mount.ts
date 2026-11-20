import type { Express } from 'express';
import { ordersRouter } from './routes';
import { adminOrdersRouter } from './routes/admin';
import { labResultsRouter } from './routes/lab-results';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  app.use('/orders', ordersRouter);
  app.use('/lab-results', labResultsRouter);
  app.use('/admin', adminOrdersRouter);
}
