import type { Request, Response } from 'express';
import * as auditService from '../services';
import { listAuditEventsQuerySchema } from '../validation';

export async function listAuditEvents(req: Request, res: Response) {
  const query = listAuditEventsQuerySchema.parse(req.query);
  const page = await auditService.listAuditEvents(query);
  res.status(200).json(page);
}
