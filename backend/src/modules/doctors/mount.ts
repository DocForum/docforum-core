import type { Express } from 'express';
import { adminDoctorsRouter, doctorsRouter, specialtiesRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  app.use('/doctors', doctorsRouter);
  app.use('/specialties', specialtiesRouter);
  app.use('/admin', adminDoctorsRouter);
}
