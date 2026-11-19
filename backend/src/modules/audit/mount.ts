import type { Express } from 'express';
import { adminAuditRouter, auditRouter, patientAuditRouter } from './routes';

/** Mounts this module's HTTP routes (see src/mounts.ts). */
export function mount(app: Express): void {
  app.use('/admin', auditRouter);
  // PHI read-access logging (Phase 8, issue #45). Mounted at root so the
  // paths match the issue's spec exactly: /admin/access-logs, /patients/me/access-log.
  app.use('/admin', adminAuditRouter);
  app.use('/patients', patientAuditRouter);
}
