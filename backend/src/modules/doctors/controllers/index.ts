import type { Request, Response } from 'express';
import * as doctorsService from '../services';
import {
  createSpecialtySchema,
  createSymptomSchema,
  publicDoctorListQuerySchema,
  setDoctorSpecialtyVerificationSchema,
  setMySpecialtiesSchema,
  setSymptomSpecialtiesSchema,
  setVerificationStatusSchema,
  symptomAutocompleteQuerySchema,
  updateDoctorProfileSchema,
  updateSpecialtySchema,
  updateSymptomSchema,
  verificationQueueQuerySchema,
} from '../validation';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import { auditActor } from '../../../middleware/request-id';
import { expectedVersion, setVersionEtag } from '../../../middleware/optimistic-concurrency';

export async function getMe(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const profile = await doctorsService.getMyDoctorProfile(req.user.id);
  setVersionEtag(res, profile.version);
  res.status(200).json(profile);
}

export async function updateMe(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const input = updateDoctorProfileSchema.parse(req.body);
  const profile = await doctorsService.updateMyDoctorProfile(req.user.id, expectedVersion(req), input);
  setVersionEtag(res, profile.version);
  res.status(200).json(profile);
}

export async function listSpecialties(_req: Request, res: Response) {
  res.status(200).json(await doctorsService.listSpecialties());
}

export async function listAdminSpecialties(_req: Request, res: Response) {
  res.status(200).json(await doctorsService.listSpecialties({ includeRetired: true }));
}

export async function listPublic(req: Request, res: Response) {
  const query = publicDoctorListQuerySchema.parse(req.query);
  res.status(200).json(await doctorsService.listPublicDoctors(query));
}

export async function getPublicDoctor(req: Request, res: Response) {
  const doctorProfileId = getParam(req, 'doctorProfileId');
  const doctor = await doctorsService.getPublicDoctor(doctorProfileId);
  res.status(200).json(doctor);
}

export async function setMySpecialties(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
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
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { status, rejectionReason } = setDoctorSpecialtyVerificationSchema.parse(req.body);
  const doctorProfileId = getParam(req, 'doctorProfileId');
  const specialtyId = getParam(req, 'specialtyId');
  const result = await doctorsService.setDoctorSpecialtyVerification(
    auditActor(req),
    req.user.id,
    doctorProfileId,
    specialtyId,
    status,
    rejectionReason,
  );
  res.status(200).json(result);
}

export async function verificationQueue(req: Request, res: Response) {
  const query = verificationQueueQuerySchema.parse(req.query);
  const result = await doctorsService.getVerificationQueue(query);
  res.status(200).json(result);
}

export async function createSpecialty(req: Request, res: Response) {
  const input = createSpecialtySchema.parse(req.body);
  const result = await doctorsService.createSpecialty(auditActor(req), input);
  res.status(201).json(result);
}

export async function updateSpecialty(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const input = updateSpecialtySchema.parse(req.body);
  const result = await doctorsService.updateSpecialty(auditActor(req), id, input);
  res.status(200).json(result);
}

export async function retireSpecialty(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const result = await doctorsService.retireSpecialty(auditActor(req), id);
  res.status(200).json(result);
}

// --- Symptom -> specialty mapping (issue #60) ----------------------------

export async function listSymptoms(req: Request, res: Response) {
  const query = symptomAutocompleteQuerySchema.parse(req.query);
  res.status(200).json(await doctorsService.searchSymptoms(query));
}

export async function listAdminSymptoms(_req: Request, res: Response) {
  res.status(200).json(await doctorsService.listSymptomsForAdmin());
}

export async function createSymptom(req: Request, res: Response) {
  const input = createSymptomSchema.parse(req.body);
  res.status(201).json(await doctorsService.createSymptom(auditActor(req), input));
}

export async function updateSymptom(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const input = updateSymptomSchema.parse(req.body);
  res.status(200).json(await doctorsService.updateSymptom(auditActor(req), id, input));
}

export async function setSymptomSpecialties(req: Request, res: Response) {
  const id = getParam(req, 'id');
  const { mappings } = setSymptomSpecialtiesSchema.parse(req.body);
  res.status(200).json(await doctorsService.setSymptomSpecialties(auditActor(req), id, mappings));
}
