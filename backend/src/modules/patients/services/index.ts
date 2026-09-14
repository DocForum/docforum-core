import { HttpError } from '../../../http-error';
import * as patientsRepo from '../repositories';

export async function getMyPatientProfile(userId: string) {
  const profile = await patientsRepo.findPatientProfileByUserId(userId);
  if (!profile) throw new HttpError(404, 'No patient profile for this account.');
  return profile;
}
