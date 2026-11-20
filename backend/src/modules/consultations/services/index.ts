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
import { config } from '../../../config';
import { prisma, runWithRlsBypassContext } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { decryptField, encryptField } from '../../../utils/field-encryption';
import * as appointmentsService from '../../appointments/services';
import * as auditService from '../../audit/services';
import * as doctorsService from '../../doctors/services';
import * as patientsService from '../../patients/services';
import { paginate, type PatientExportSection } from '../../patients/services';
import * as consultationsRepo from '../repositories';
import * as referralsService from '../../referrals/services';
import type { ReferralTargetInput } from '../../referrals/services';
import { createFollowUpRequestForConsultation } from './follow-ups';

export * from './messages';
export * from './attachments';
export * from './follow-ups';
export * from './sign-off';

export interface ConsultationInput {
  appointmentId: string;
  /** Required by the close routes (`closeConsultationSchema`); optional here
   * only so the create route can open a record before sign-off (Phase 3's
   * referral slice, matching `POST /consultations`). */
  outcome?: ConsultationOutcome | null;
  notes?: string | null;
  /** Issue #63: optional suggested window for the follow-up request created
   * when `outcome` is `follow_up_needed`. Defaults to now → now + the
   * configured window length. */
  followUpWindowStart?: Date;
  followUpWindowEnd?: Date;
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
  const notesCiphertext = notes === null ? null : (encryptField(notes) ?? null);

  const followUpWindowStart = input.followUpWindowStart ?? new Date();
  const followUpWindowEnd =
    input.followUpWindowEnd ??
    new Date(
      followUpWindowStart.getTime() + config.consultations.followUpWindowDays * 24 * 60 * 60 * 1000,
    );

  let consultation;
  try {
    consultation = await prisma.$transaction(async (tx) => {
      const record = await consultationsRepo.createConsultation(tx, {
        appointmentId: input.appointmentId,
        outcome: input.outcome ?? null,
        notes: notesCiphertext,
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

      // Issue #63: a follow-up outcome produces a bookable request in the
      // same transaction — the close and the request exist together or not
      // at all.
      if (record.outcome === 'follow_up_needed') {
        await createFollowUpRequestForConsultation(tx, {
          consultationId: record.id,
          doctorProfileId: appointment.doctorProfileId,
          patientProfileId: appointment.patientProfileId,
          notesCiphertext,
          windowStart: followUpWindowStart,
          windowEnd: followUpWindowEnd,
        });
      }

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
  return { consultation: { ...consultation, notes, addenda: [] }, appointment };
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

/**
 * Issue #10: the state rule for hanging a prescription or lab order off a
 * consultation. A consultation is orderable while it is open (no `outcome`
 * yet — "active") or after sign-off ("completed"), as long as the visit
 * behind it actually happened: its appointment must be `completed`. The
 * close routes already refuse to create a consultation for anything else,
 * so this is the last line of defence for rows that reached the table
 * another way (or an appointment that is not in the state the record
 * claims). Callers check *who* is asking first, so a stranger learns
 * nothing about the consultation's state from this 409.
 */
export function assertConsultationAcceptsOrders(consultation: { appointment: { status: string } | null }) {
  if (!consultation.appointment || consultation.appointment.status !== 'completed') {
    throw new HttpError(409, 'Orders can only be issued from a consultation whose appointment is completed.');
  }
}

/** Visible to the treating doctor and the patient of the underlying
 * appointment — nothing wider in v1. `notes` is decrypted for the reader;
 * the stored ciphertext never leaves this module. */
export async function getConsultation(userId: string, consultationId: string) {
  const consultation = await consultationsRepo.findConsultationById(prisma, consultationId);
  if (!consultation) throw new HttpError(404, 'Consultation not found.');

  if (consultation.appointment) {
    const addenda = consultation.addenda.map((addendum) => ({
      id: addendum.id,
      authorUserId: addendum.authorUserId,
      body: decryptField(addendum.body) ?? '',
      createdAt: addendum.createdAt,
    }));
    const doctor = await doctorsService.getMyDoctorProfile(userId).catch(() => null);
    if (doctor && doctor.id === consultation.appointment.doctorProfileId) {
      return { ...consultation, notes: decryptField(consultation.notes), addenda };
    }
    const patient = await patientsService.getMyPatientProfile(userId).catch(() => null);
    if (patient && patient.id === consultation.appointment.patientProfileId) {
      return { ...consultation, notes: decryptField(consultation.notes), addenda };
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

/**
 * Account-deletion retention hold (Phase 8, issue #41, docs/adr/0010): a
 * patient with a consultation or a follow-up request has clinical records
 * this module must keep. The appointments hold already covers every
 * consultation, but the negative dependency is made explicit here so a later
 * change to appointment retention cannot orphan a note or thread. Runs under
 * the RLS bypass role because the purge job has no request identity.
 */
export async function hasClinicalRecordsForPatient(patientProfileId: string): Promise<boolean> {
  return runWithRlsBypassContext(async () => {
    const consultation = await prisma.consultation.findFirst({
      where: { appointment: { patientProfileId } },
      select: { id: true },
    });
    if (consultation) return true;
    const followUp = await prisma.followUpRequest.findFirst({
      where: { patientProfileId },
      select: { id: true },
    });
    return followUp !== null;
  });
}

/** This module's contribution to the patient data export (issue #40): the
 * consultation note, its addenda, the async thread and the follow-up request.
 * Right of access has to cover PHI this module stores, not just the note. */
export const consultationsExportSection: PatientExportSection = {
  name: 'consultations',
  version: 1,
  pages(subject, pageSize) {
    return paginate(
      pageSize,
      (cursor, take) => consultationsRepo.findConsultationsPageForPatient(subject.patientProfileId, cursor, take),
      (rows) =>
        rows.map((row) => ({
          id: row.id,
          appointmentId: row.appointmentId,
          outcome: row.outcome,
          notes: decryptField(row.notes) ?? null,
          signedAt: row.signedAt,
          createdAt: row.createdAt,
          addenda: row.addenda.map((addendum) => ({
            id: addendum.id,
            body: decryptField(addendum.body) ?? '',
            createdAt: addendum.createdAt,
          })),
          messages: row.messages.map((message) => ({
            id: message.id,
            senderRole: message.senderRole,
            body: decryptField(message.body) ?? '',
            createdAt: message.createdAt,
            attachments: message.attachments.map((attachment) => ({
              id: attachment.id,
              fileName: attachment.fileName,
              contentType: attachment.contentType,
              sizeBytes: attachment.sizeBytes,
              createdAt: attachment.createdAt,
            })),
          })),
          followUp: row.followUp
            ? {
                id: row.followUp.id,
                windowStart: row.followUp.windowStart,
                windowEnd: row.followUp.windowEnd,
                status: row.followUp.status,
                intakeFormId: row.followUp.intakeFormId,
              }
            : null,
        })),
    );
  },
};
