import { HttpError } from '../../../http-error';
import { prisma } from '../../../db/prisma-client';
import * as auditService from '../../audit/services';
import * as doctorsRepo from '../repositories';
import type { VerificationStatus } from '@prisma/client';

export async function getMyDoctorProfile(userId: string) {
  const profile = await doctorsRepo.findDoctorProfileByUserId(userId);
  if (!profile) throw new HttpError(404, 'No doctor profile for this account.');
  return profile;
}

export function listSpecialties() {
  return doctorsRepo.findSpecialties();
}

export async function listPublicDoctors(input: {
  specialty?: string;
  q?: string;
  limit: number;
  cursor?: string;
}) {
  const ranked = await doctorsRepo.searchVerifiedDoctorIds({
    query: input.q ?? null,
    specialtySlug: input.specialty ?? null,
    cursor: input.cursor ?? null,
    take: input.limit + 1,
  });
  const hasMore = ranked.length > input.limit;
  const page = ranked.slice(0, input.limit);
  const details = await doctorsRepo.findPublicDoctorDetails(page.map((doctor) => doctor.id));
  const detailsById = new Map(details.map((doctor) => [doctor.id, doctor]));

  return {
    items: page.flatMap((rankedDoctor) => {
      const doctor = detailsById.get(rankedDoctor.id);
      if (!doctor) return [];
      return [{
        id: doctor.id,
        fullName: doctor.fullName,
        specialties: doctor.specialties.map((assignment) => assignment.specialty),
      }];
    }),
    nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
  };
}

export async function setMySpecialties(userId: string, requestedIds: string[]) {
  const specialtyIds = [...new Set(requestedIds)];
  return prisma.$transaction(async (tx) => {
    const profile = await doctorsRepo.findDoctorProfileByUserId(userId, tx);
    if (!profile) throw new HttpError(404, 'No doctor profile for this account.');

    const specialties = await doctorsRepo.findSpecialtiesByIds(specialtyIds, tx);
    if (specialties.length !== specialtyIds.length) {
      throw new HttpError(400, 'One or more specialty ids are unknown.');
    }

    await doctorsRepo.replaceDoctorSpecialties(tx, profile.id, specialtyIds);
    return { specialties: specialties.sort((a, b) => a.name.localeCompare(b.name)) };
  });
}

export async function getDoctorProfileById(doctorProfileId: string) {
  const profile = await doctorsRepo.findDoctorProfileById(doctorProfileId);
  if (!profile) throw new HttpError(404, 'Doctor profile not found.');
  return profile;
}

/** Batch id -> { id, fullName } lookup for other modules (patient data
 * export, issue #40). Public-facing fields only. */
export async function getDoctorSummariesByIds(ids: string[]): Promise<Map<string, { id: string; fullName: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await doctorsRepo.findDoctorSummariesByIds([...new Set(ids)]);
  return new Map(rows.map((row) => [row.id, { id: row.id, fullName: row.fullName }]));
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
 *
 * Phase 8, issue #43: the flip and its AuditEvent (who, from, to) commit
 * together. Setting the status it already has is not a transition — it
 * returns the profile unchanged and records nothing.
 */
export async function setVerificationStatus(
  actor: auditService.AuditActor,
  doctorProfileId: string,
  status: VerificationStatus,
) {
  return prisma.$transaction(async (tx) => {
    const current = await doctorsRepo.lockVerificationStatus(tx, doctorProfileId);
    if (current === null) throw new HttpError(404, 'Doctor profile not found.');
    if (current === status) {
      return (await doctorsRepo.findDoctorProfileById(doctorProfileId, tx))!;
    }
    const profile = await doctorsRepo.updateVerificationStatus(tx, doctorProfileId, status);
    await auditService.record(tx, actor, {
      entityType: 'DoctorProfile',
      entityId: doctorProfileId,
      action: 'doctor.verification_status_changed',
      fromState: current,
      toState: status,
    });
    return profile;
  });
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

/**
 * Eligible recipients for a specialty-only referral (issue #6, ADR 0008):
 * verified doctors holding the specialty, excluding the given ids (the
 * referring doctor, plus anything the caller has already targeted in the
 * same batch) and doctors whose account is deactivated. The referrals
 * module decides *which* of these receives the referral — this module
 * only owns the definition of eligibility, so the manual and routed
 * paths cannot drift apart.
 */
export async function listEligibleReferralTargets(specialtyId: string, excludeDoctorProfileIds: string[] = []) {
  const rows = await doctorsRepo.findEligibleDoctorsForSpecialty(specialtyId, excludeDoctorProfileIds);
  return rows.map((row) => row.doctorProfileId);
}

/** Count and oldest-item age for the admin overview (issue #123). No PHI. */
export async function doctorVerificationQueueCounts() {
  const stats = await doctorsRepo.findPendingVerificationStats();
  const oldestAgeSeconds = stats.oldestCreatedAt
    ? Math.max(0, Math.floor((Date.now() - stats.oldestCreatedAt.getTime()) / 1000))
    : null;
  return { count: stats.count, oldestAgeSeconds };
}
