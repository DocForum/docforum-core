import type { Request, Response } from 'express';
import * as consultationsService from '../services';
import { closeConsultationSchema, createConsultationSchema, createReferralsSchema } from '../validation';
import { HttpError } from '../../../http-error';
import { auditActor } from '../../../middleware/request-id';
import { getParam } from '../../../request-params';
import * as consultationsService from '../services';
import {
  addAddendumSchema,
  createConsultationSchema,
  createReferralsSchema,
  updateConsultationSchema,
} from '../validation';

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
  return req.user.id;
}

export async function create(req: Request, res: Response) {
  const input = createConsultationSchema.parse(req.body);
  const { consultation } = await consultationsService.createConsultation(auditActor(req), input);
  res.status(201).json(consultation);
}

export async function get(req: Request, res: Response) {
  const consultation = await consultationsService.getConsultation(requireUserId(req), getParam(req, 'id'));
  res.status(200).json(consultation);
}

export async function update(req: Request, res: Response) {
  const input = updateConsultationSchema.parse(req.body);
  const consultation = await consultationsService.updateConsultation(requireUserId(req), getParam(req, 'id'), input);
  res.status(200).json(consultation);
}

export async function signOff(req: Request, res: Response) {
  const consultation = await consultationsService.signOffConsultation(requireUserId(req), getParam(req, 'id'));
  res.status(200).json(consultation);
}

export async function addAddendum(req: Request, res: Response) {
  const { body } = addAddendumSchema.parse(req.body);
  const consultation = await consultationsService.addAddendum(requireUserId(req), getParam(req, 'id'), body);
  res.status(201).json(consultation);
}

/** Issue #66 (PRD §8.2.4): multiple simultaneous referrals from one
 * consultation, atomic all-or-none, each with its own snapshot copy. */
export async function createReferrals(req: Request, res: Response) {
  const { targets } = createReferralsSchema.parse(req.body);
  const referrals = await consultationsService.createReferrals(
    requireUserId(req),
    getParam(req, 'consultationId'),
    targets,
  );
  res.status(201).json(referrals);
}
