// Consultations services — minimal Phase-3 slice (issue #5's lineage
// host + issue #66's multi-referral endpoint). Full consultation record
// workflow (issue #4: sign-off, addenda) stays open; this exists so a
// referral has a consultation to grow out of and a lineage to walk.
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import type { ConsultationOutcome } from '@prisma/client';
import * as consultationsRepo from '../repositories';
import * as referralsService from '../../referrals/services';
import * as doctorsService from '../../doctors/services';
import * as patientsService from '../../patients/services';
import type { ReferralTargetInput } from '../../referrals/services';

/** Doctor records a consultation against their own completed appointment.
 * One consultation per appointment (unique appointmentId) — a re-visit is
 * a new appointment, not a second row here. */
export async function createConsultation(
  userId: string,
  input: { appointmentId: string; outcome?: ConsultationOutcome; notes?: string },
) {
  const doctor = await doctorsService.getMyDoctorProfile(userId);

  return prisma.$transaction(async (tx) => {
    const appointment = await tx.appointment.findUnique({ where: { id: input.appointmentId } });
    if (!appointment) throw new HttpError(404, 'Appointment not found.');
    if (appointment.doctorProfileId !== doctor.id) {
      throw new HttpError(403, 'You can only record consultations for your own appointments.');
    }
    if (appointment.status !== 'completed') {
      throw new HttpError(409, 'A consultation is recorded against a completed appointment.');
    }
    const existing = await consultationsRepo.findConsultationByAppointmentId(tx, input.appointmentId);
    if (existing) {
      throw new HttpError(409, 'A consultation already exists for this appointment.');
    }
    return consultationsRepo.createConsultation(tx, {
      appointmentId: input.appointmentId,
      outcome: input.outcome,
      notes: input.notes,
    });
  });
}

/** Visible to the treating doctor and the patient of the underlying
 * appointment — nothing wider in v1. */
export async function getConsultation(userId: string, consultationId: string) {
  const consultation = await consultationsRepo.findConsultationById(prisma, consultationId);
  if (!consultation) throw new HttpError(404, 'Consultation not found.');

  if (consultation.appointment) {
    const doctor = await doctorsService.getMyDoctorProfile(userId).catch(() => null);
    if (doctor && doctor.id === consultation.appointment.doctorProfileId) return consultation;
    const patient = await patientsService.getMyPatientProfile(userId).catch(() => null);
    if (patient && patient.id === consultation.appointment.patientProfileId) return consultation;
  }
  throw new HttpError(403, 'You do not have access to this consultation.');
}

/**
 * POST /consultations/:id/referrals (issue #66): multiple simultaneous
 * referrals from one consultation, atomically. Delegates to the
 * referrals service — the referral write surface lives there; this is a
 * service-to-service call across the module boundary, never a repository
 * import.
 */
export async function createReferrals(
  userId: string,
  consultationId: string,
  targets: ReferralTargetInput[],
) {
  return referralsService.createReferralBatch(userId, consultationId, targets);
}
