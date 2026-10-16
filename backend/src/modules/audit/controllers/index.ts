// audit controllers — read-side of the PHI access log (issue #45).
import type { Request, Response } from 'express';
import { z } from 'zod';
import * as auditService from '../services';
import { HttpError } from '../../../http-error';
import { prisma } from '../../../db/prisma-client';

const entityQuerySchema = z.object({
  entityType: z.string().min(1),
  entityId: z.string().min(1),
});

/** GET /admin/access-logs?entityType=Consultation&entityId=... — admin only.
 * Returns who accessed a specific entity. */
export async function getAccessLogsByEntity(req: Request, res: Response) {
  const parsed = entityQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new HttpError(400, 'entityType and entityId query parameters are required.');
  }
  const { entityType, entityId } = parsed.data;
  const logs = await auditService.getAccessByEntity(entityType, entityId);
  res.status(200).json({ logs });
}

/** GET /admin/access-logs/user?userId=... — admin only.
 * Returns what a specific user has accessed. */
export async function getAccessLogsByUser(req: Request, res: Response) {
  const userId = z.string().min(1).parse(req.query.userId);
  const logs = await auditService.getAccessByUser(userId);
  res.status(200).json({ logs });
}

/** GET /admin/access-logs/stats — admin only.
 * Returns the logging failure count for alerting. */
export async function getAccessLogStats(_req: Request, res: Response) {
  res.status(200).json({
    logFailures: auditService.getLogFailureCount(),
    retentionDays: auditService.ACCESS_LOG_RETENTION_DAYS,
  });
}

/** GET /patients/me/access-log — patient only.
 * Returns who viewed MY records (role + entity + timestamp, no viewer PII). */
export async function getMyAccessLog(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');

  // Resolve the caller's patientProfileId — scoped to the caller, never
  // client-supplied (issue #45 review note: patient sees only their own).
  const profile = await prisma.patientProfile.findUnique({
    where: { userId: req.user.id },
    select: { id: true },
  });
  if (!profile) throw new HttpError(404, 'No patient profile found for this account.');

  const logs = await auditService.getAccessForPatient(profile.id);
  res.status(200).json({ logs });
}
