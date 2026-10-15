import type { Request, Response } from 'express';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import * as consultationsService from '../services';
import { addAddendumSchema, createConsultationSchema, updateConsultationSchema } from '../validation';

function requireUserId(req: Request): string {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  return req.user.id;
}

export async function create(req: Request, res: Response) {
  const input = createConsultationSchema.parse(req.body);
  const consultation = await consultationsService.createConsultation(requireUserId(req), input);
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
