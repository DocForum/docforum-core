import type { Express } from 'express';
import { labTestsRouter } from './routes';

export function mount(app: Express): void {
  app.use('/lab-tests', labTestsRouter);
}