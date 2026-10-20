import type { Request, Response } from 'express';
import * as auditService from '../services';
import { getMyPatientProfile } from '../../patients/services';
import { HttpError } from '../../../http-error';
import {
  listAuditEventsQuerySchema,
  patientAccessLogQuerySchema,
  accessLogByEntityQuerySchema,
  accessLogByUserQuerySchema,
} from '../validation';

export async function listAuditEvents(req: Request, res: Response) {
  const query = listAuditEventsQuerySchema.parse(req.query);
  const page = await auditService.listAuditEvents(query);
  res.status(200).json(page);
}

// --- PHI read-access logging (Phase 8, issue #45) ---------------------------

/** Admin: who accessed a specific kind of record (optionally a specific
 * one). Viewer ids are kept — admins need attribution for incident
 * response; the patient-facing endpoint is the one that strips PII. */
export async function listAccessLogsByEntity(req: Request, res: Response) {
  const query = accessLogByEntityQuerySchema.parse(req.query);
  const logs = await auditService.listAccessForEntity(query);
  res.status(200).json({ items: logs });
}

/** Admin: what a specific user accessed. */
export async function listAccessLogsByUser(req: Request, res: Response) {
  const query = accessLogByUserQuerySchema.parse(req.query);
  const logs = await auditService.listAccessForUser(query);
  res.status(200).json({ items: logs });
}

/** Admin: cumulative write-failure count + retention config (alerting). */
export async function accessLogStats(_req: Request, res: Response) {
  res.status(200).json(auditService.getAccessLogStats());
}

/** Patient: who viewed MY records. The profile id is resolved server-side
 * from the authenticated user — never read from the request — so a caller
 * can only ever see their own log. */
export async function myAccessLog(req: Request, res: Response) {
  const query = patientAccessLogQuerySchema.parse(req.query);
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const profile = await getMyPatientProfile(req.user.id);
  const logs = await auditService.getAccessForPatient(profile.id, query.limit);
  res.status(200).json({ items: logs });
}
