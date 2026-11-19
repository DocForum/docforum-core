import type { Express } from 'express';
import { ordersRouter } from './routes';
import { adminOrdersRouter } from './routes/admin';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  app.use('/orders', ordersRouter);
  app.use('/admin', adminOrdersRouter);
}
