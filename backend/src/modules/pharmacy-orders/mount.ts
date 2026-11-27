import type { Express } from 'express';
import { fulfillmentProofsRouter, pharmacyOrdersRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  app.use('/pharmacy-orders', pharmacyOrdersRouter);
  app.use('/fulfillment-proofs', fulfillmentProofsRouter);
}
