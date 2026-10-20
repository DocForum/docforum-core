import type { Request, Response } from 'express';
import * as consultationsService from '../services';
import { closeConsultationSchema, createConsultationSchema, createReferralsSchema } from '../validation';
import { HttpError } from '../../../http-error';
import { auditActor } from '../../../middleware/request-id';
import { getParam } from '../../../request-params';

/** POST /appointments/:appointmentId/consultation — close (create) the
 * consultation for the appointment in the path. */
export async function closeConsultation(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const appointmentId = getParam(req, 'appointmentId');
  const { outcome, notes } = closeConsultationSchema.parse(req.body);

  const { consultation, appointment } = await consultationsService.createConsultation(auditActor(req), {
    appointmentId,
    outcome,
    notes,
  });

  res.status(201).json({ consultation, appointment });
}

/** POST /consultations — the same write, with the appointment in the body.
 * Kept because Phase 3's referral flow and its tests address it this way. */
export async function create(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const input = createConsultationSchema.parse(req.body);
  const { consultation } = await consultationsService.createConsultation(auditActor(req), input);
  res.status(201).json(consultation);
}

export async function getOne(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const consultation = await consultationsService.getConsultation(req.user.id, getParam(req, 'consultationId'));
  res.status(200).json(consultation);
}

export async function createReferrals(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { targets } = createReferralsSchema.parse(req.body);
  const referrals = await consultationsService.createReferrals(
    req.user.id,
    getParam(req, 'consultationId'),
    targets,
  );
  res.status(201).json(referrals);
}
