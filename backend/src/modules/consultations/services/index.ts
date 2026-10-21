// Consultations services — one write path for the Consultation record.
//
// Phase 2, issue #4 ("close a consultation exactly once") and Phase 3's
// minimal slice (issue #5's lineage host + issue #66's multi-referral
// endpoint) both create this row, so they share `createConsultation` below
// rather than each writing the table their own way. The routes that reach it
// (`POST /consultations`, `POST /appointments/:id/consultation`, and the
// orders module's consultation step) are three addresses for one operation,
// not three implementations.
import { Prisma, type ConsultationOutcome } from '@prisma/client';
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { decryptField, encryptField } from '../../../utils/field-encryption';
import * as appointmentsService from '../../appointments/services';
import * as auditService from '../../audit/services';
import * as doctorsService from '../../doctors/services';
import * as patientsService from '../../patients/services';
import * as consultationsRepo from '../repositories';
import * as referralsService from '../../referrals/services';
import type { ReferralTargetInput } from '../../referrals/services';

export interface ConsultationInput {
  appointmentId: string;
  /** Required by the close routes (`closeConsultationSchema`); optional here
   * only so the create route can open a record before sign-off (Phase 3's
   * referral slice, matching `POST /consultations`). */
  outcome?: ConsultationOutcome | null;
  notes?: string | null;
}

/**
 * Create (close) the consultation for the caller's own appointment, exactly
 * once.
 *
 * - The one-consultation-per-appointment guarantee is enforced at the DB
 *   level by `Consultation.appointmentId UNIQUE`, not by a check-then-write
 *   here. Two concurrent closes both reach the INSERT; exactly one commits,
 *   the loser gets P2002 and a 409 (docs/adr/0009).
 * - "Doctor-only, own-appointment-only" is enforced by reading the
 *   Appointment through appointmentsService (the only legal cross-module
 *   seam per AGENTS.md hard rule 4): that service returns null for an
 *   appointment that doesn't exist or isn't the caller's, and this service
 *   answers 404 either way so it never reveals that someone else's
 *   appointment exists.
 * - A consultation is recorded against a `completed` appointment — the visit
 *   that produced it has to have happened (Phase 3's referral precondition).
 * - Single-use in v1: no amendments/edits. That is an explicit open
 *   question (ROADMAP.md Phase 2), not an assumption we silently bake in.
 * - `notes` is clinical free text and is stored as an AES-256-GCM envelope
 *   (ARCHITECTURE.md §4.3 / §2 — Phase 8 issue #46), never plaintext, so
 *   every writer goes through here. The ciphertext is unsearchable by
 *   design; reads decrypt in the app layer.
 */
export async function createConsultation(actor: auditService.AuditActor, input: ConsultationInput) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');

  const appointment = await appointmentsService.getAppointmentForDoctor(actor.userId, input.appointmentId);
  if (!appointment) {
    throw new HttpError(404, 'Appointment not found.');
  }
  if (appointment.status !== 'completed') {
    throw new HttpError(409, 'A consultation is recorded against a completed appointment.');
  }

  const notes = input.notes ?? null;

  let consultation;
  try {
    consultation = await prisma.$transaction(async (tx) => {
      const record = await consultationsRepo.createConsultation(tx, {
        appointmentId: input.appointmentId,
        outcome: input.outcome ?? null,
        notes: notes === null ? null : (encryptField(notes) ?? null),
      });

      // Phase 8 audit trail (issue #43): the state change and its event commit
      // together, so an event exists iff the consultation was actually closed.
      await auditService.record(tx, actor, {
        entityType: 'Consultation',
        entityId: record.id,
        action: 'consultation.closed',
        fromState: null,
        toState: record.outcome,
        metadata: { appointmentId: record.appointmentId },
      });

      return record;
    });
  } catch (err) {
    // The DB unique constraint is the actual guarantee; translate the race's
    // loser into a 409 rather than a 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, 'A consultation for this appointment has already been closed.');
    }
    throw err;
  }

  // The caller just wrote these notes, so hand them back in plaintext rather
  // than leaking the stored ciphertext envelope.
  return { consultation: { ...consultation, notes }, appointment };
}

/** Service-to-service read for modules that hang records off a consultation
 * (orders: prescriptions, lab orders). Returns the stored row as-is — callers
 * outside this module never touch `Consultation` themselves (AGENTS.md hard
 * rule 4). */
export async function getConsultationRecord(consultationId: string) {
  const consultation = await consultationsRepo.findConsultationById(prisma, consultationId);
  if (!consultation) throw new HttpError(404, 'Consultation not found.');
  return consultation;
}

/** Visible to the treating doctor and the patient of the underlying
 * appointment — nothing wider in v1. `notes` is decrypted for the reader;
 * the stored ciphertext never leaves this module. */
export async function getConsultation(userId: string, consultationId: string) {
  const consultation = await consultationsRepo.findConsultationById(prisma, consultationId);
  if (!consultation) throw new HttpError(404, 'Consultation not found.');

  if (consultation.appointment) {
    const doctor = await doctorsService.getMyDoctorProfile(userId).catch(() => null);
    if (doctor && doctor.id === consultation.appointment.doctorProfileId) {
      return { ...consultation, notes: decryptField(consultation.notes) };
    }
    const patient = await patientsService.getMyPatientProfile(userId).catch(() => null);
    if (patient && patient.id === consultation.appointment.patientProfileId) {
      return { ...consultation, notes: decryptField(consultation.notes) };
    }
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
