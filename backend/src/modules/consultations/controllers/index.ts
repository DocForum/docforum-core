import type { Request, Response } from 'express';
import * as consultationsService from '../services';
import { closeConsultationSchema } from '../validation';
import { HttpError } from '../../../http-error';
import { auditActor } from '../../../middleware/request-id';
import { getParam } from '../../../request-params';

export async function closeConsultation(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const appointmentId = getParam(req, 'appointmentId');
  const { outcome, notes } = closeConsultationSchema.parse(req.body);

  const { consultation, appointment } = await consultationsService.closeConsultation(
    auditActor(req),
    appointmentId,
    outcome,
    notes,
  );

  res.status(201).json({ consultation, appointment });
}
