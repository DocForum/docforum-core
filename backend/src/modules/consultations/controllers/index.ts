import type { Request, Response } from 'express';
import * as consultationsService from '../services';
import { createConsultationSchema, createReferralsSchema } from '../validation';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';

export async function create(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const input = createConsultationSchema.parse(req.body);
  const consultation = await consultationsService.createConsultation(req.user.id, input);
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
