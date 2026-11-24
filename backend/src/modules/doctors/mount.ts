import type { Express } from 'express';
import { adminDoctorsRouter, doctorsRouter, specialtiesRouter, symptomsRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  app.use('/doctors', doctorsRouter);
  app.use('/specialties', specialtiesRouter);
  app.use('/symptoms', symptomsRouter);
  app.use('/admin', adminDoctorsRouter);
}
