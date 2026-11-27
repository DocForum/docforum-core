import type { Request, Response } from 'express';
import { HttpError } from '../../../http-error';
import { auditActor } from '../../../middleware/request-id';
import * as intakeService from '../services';
import { createIntakeSchema } from '../validation';

export async function create(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const input = createIntakeSchema.parse(req.body);
  const intake = await intakeService.createMyIntake(auditActor(req), input);
  res.status(201).json(intake);
}

export async function listMine(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  res.status(200).json(await intakeService.listMyIntakes(req.user.id));
}
