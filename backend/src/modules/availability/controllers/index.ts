import type { Request, Response } from 'express';
import * as availabilityService from '../services';
import { generateSlotsSchema } from '../validation';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';

export async function listSlots(req: Request, res: Response) {
  const doctorProfileId = getParam(req, 'doctorProfileId');
  const slots = await availabilityService.listOpenSlots(doctorProfileId);
  res.status(200).json(slots);
}

export async function generateSlots(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const doctorProfileId = getParam(req, 'doctorProfileId');
  await availabilityService.assertCanGenerateFor(req.user.id, doctorProfileId);

  const input = generateSlotsSchema.parse(req.body);
  const result = await availabilityService.generateSlots({ doctorProfileId, ...input });
  res.status(201).json(result);
}
