import { HttpError } from '../../../http-error';
import * as doctorsRepo from '../repositories';
import type { VerificationStatus } from '@prisma/client';

export async function getMyDoctorProfile(userId: string) {
  const profile = await doctorsRepo.findDoctorProfileByUserId(userId);
  if (!profile) throw new HttpError(404, 'No doctor profile for this account.');
  return profile;
}

export async function getDoctorProfileById(doctorProfileId: string) {
  const profile = await doctorsRepo.findDoctorProfileById(doctorProfileId);
  if (!profile) throw new HttpError(404, 'Doctor profile not found.');
  return profile;
}

/** Only a doctor acting on their own profile may generate slots for it —
 * no admin-on-behalf-of override in Phase 1. */
export async function assertOwnsDoctorProfile(userId: string, doctorProfileId: string) {
  const profile = await getDoctorProfileById(doctorProfileId);
  if (profile.userId !== userId) {
    throw new HttpError(403, 'You can only manage your own doctor profile.');
  }
  return profile;
}

/**
 * Doctor verification: manual, admin-gated (PRD §6.1 FR-3 — "verification
 * workflow is manual/admin-gated in v1"). No automated verification
 * pipeline exists or is planned for v1; this is intentionally just a
 * status flip an admin performs after some out-of-band check.
 */
export async function setVerificationStatus(doctorProfileId: string, status: VerificationStatus) {
  await getDoctorProfileById(doctorProfileId); // 404s if missing
  return doctorsRepo.updateVerificationStatus(doctorProfileId, status);
}

/** A referral target (or admin-reassignment target) must be a verified
 * doctor — an unverified profile has no business receiving patients
 * (issue #68: reassignment goes through this gate, never around it). */
export async function assertDoctorVerified(doctorProfileId: string) {
  const profile = await getDoctorProfileById(doctorProfileId);
  if (profile.verificationStatus !== 'verified') {
    throw new HttpError(422, 'Target doctor is not verified.');
  }
  return profile;
}

/**
 * Issue #68: the reassignment target must be verified AND actually hold
 * the referral's target specialty. Checked through this module's own
 * repository — callers (referrals/admin ops) never touch DoctorSpecialty
 * directly (module-boundary hard rule).
 */
export async function assertDoctorVerifiedInSpecialty(doctorProfileId: string, specialtyId: string) {
  const profile = await assertDoctorVerified(doctorProfileId);
  const specialties = await doctorsRepo.findDoctorSpecialties(doctorProfileId);
  const holds = specialties.some((link) => link.specialtyId === specialtyId);
  if (!holds) {
    throw new HttpError(422, 'Target doctor does not hold the referral’s specialty.');
  }
  return profile;
}

/** Doctor's specialty ids — used by referral creation to denormalise the
 * target specialty onto the referral for the loop guard. */
export async function listDoctorSpecialtyIds(doctorProfileId: string) {
  const specialties = await doctorsRepo.findDoctorSpecialties(doctorProfileId);
  return specialties.map((link) => link.specialtyId);
}
