import { config } from '../../../config';
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import * as doctorsService from '../../doctors/services';
import * as patientsService from '../../patients/services';
import * as consultationsRepo from '../repositories';

export type ThreadRole = 'patient' | 'doctor';

export interface ThreadContext {
  consultation: NonNullable<Awaited<ReturnType<typeof consultationsRepo.findConsultationById>>>;
  role: ThreadRole;
  /** The logged-in user ids on each side, when the profile has a login
   * (a dependent's profile has none, issue #42). */
  patientUserId: string | null;
  doctorUserId: string | null;
}

/**
 * Resolves the caller against a consultation thread (issue #61). Membership
 * is exactly the underlying appointment's patient and treating doctor —
 * PRD §7's privacy line. A specialist who receives a *new* referral gets
 * access to that referral's thread, never to the earlier one, because access
 * is derived from each consultation's own appointment.
 */
export async function resolveThreadContext(userId: string, consultationId: string): Promise<ThreadContext> {
  const consultation = await consultationsRepo.findConsultationById(prisma, consultationId);
  if (!consultation) throw new HttpError('CONSULTATION_NOT_FOUND', 'Consultation not found.');

  const doctor = await doctorsService
    .getDoctorProfileById(consultation.appointment.doctorProfileId)
    .catch(() => null);
  const patient = await patientsService
    .getPatientProfileById(consultation.appointment.patientProfileId)
    .catch(() => null);

  const patientUserId = patient?.userId ?? null;
  const doctorUserId = doctor?.userId ?? null;

  let role: ThreadRole | null = null;
  if (doctorUserId === userId) role = 'doctor';
  else if (patientUserId === userId) role = 'patient';

  if (!role) throw new HttpError('CONSULTATION_FORBIDDEN', 'You do not have access to this consultation.');

  return { consultation, role, patientUserId, doctorUserId };
}

/**
 * Issue #61's closing rule: no new messages once the configured number of
 * days has passed since the consultation was closed. `Consultation.createdAt`
 * is that moment — the row is created when the visit is closed — used as the
 * completion anchor until `Appointment.completedAt` exists.
 */
export function assertThreadOpen(consultation: { createdAt: Date }): void {
  const closesAt = new Date(
    consultation.createdAt.getTime() + config.consultations.threadCloseAfterDays * 24 * 60 * 60 * 1000,
  );
  if (Date.now() > closesAt.getTime()) {
    throw new HttpError('CONSULTATION_THREAD_CLOSED', 'This consultation thread is closed for new messages.');
  }
}

export function decryptOrNull(value: string | null): string | null {
  return value;
}
