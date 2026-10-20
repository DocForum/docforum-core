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
