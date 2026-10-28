import type { Request, Response } from 'express';
import * as doctorsService from '../services';
import { publicDoctorListQuerySchema, setDoctorSpecialtyVerificationSchema, setMySpecialtiesSchema, setVerificationStatusSchema } from '../validation';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import { auditActor } from '../../../middleware/request-id';

export async function getMe(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const profile = await doctorsService.getMyDoctorProfile(req.user.id);
  res.status(200).json(profile);
}

export async function listSpecialties(_req: Request, res: Response) {
  res.status(200).json(await doctorsService.listSpecialties());
}

export async function listPublic(req: Request, res: Response) {
  const query = publicDoctorListQuerySchema.parse(req.query);
  res.status(200).json(await doctorsService.listPublicDoctors(query));
}

export async function setMySpecialties(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { specialtyIds } = setMySpecialtiesSchema.parse(req.body);
  res.status(200).json(await doctorsService.setMySpecialties(req.user.id, specialtyIds));
}

export async function setVerification(req: Request, res: Response) {
  const { status } = setVerificationStatusSchema.parse(req.body);
  const doctorProfileId = getParam(req, 'doctorProfileId');
  const profile = await doctorsService.setVerificationStatus(auditActor(req), doctorProfileId, status);
  res.status(200).json(profile);
}

export async function setDoctorSpecialtyVerification(req: Request, res: Response) {
  const { status, reviewer, rejectionReason } = setDoctorSpecialtyVerificationSchema.parse(req.body);
  const doctorProfileId = getParam(req, 'doctorProfileId');
  const specialtyId = getParam(req, 'specialtyId');
  const result = await doctorsService.setDoctorSpecialtyVerification(
    doctorProfileId,
    specialtyId,
    status,
    reviewer,
    rejectionReason,
  );
  res.status(200).json(result);
}
