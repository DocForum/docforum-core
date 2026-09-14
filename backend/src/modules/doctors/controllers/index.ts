import type { Request, Response } from 'express';
import * as doctorsService from '../services';
import { setVerificationStatusSchema } from '../validation';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';

export async function getMe(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const profile = await doctorsService.getMyDoctorProfile(req.user.id);
  res.status(200).json(profile);
}

export async function setVerification(req: Request, res: Response) {
  const { status } = setVerificationStatusSchema.parse(req.body);
  const doctorProfileId = getParam(req, 'doctorProfileId');
  const profile = await doctorsService.setVerificationStatus(doctorProfileId, status);
  res.status(200).json(profile);
}
