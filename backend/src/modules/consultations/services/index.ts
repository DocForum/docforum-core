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
 * - Issue #64: creating a consultation no longer freezes its notes. The
 *   record is unsigned (`signedAt` null) until the treating doctor calls
 *   `signOffConsultation` (or the auto sign-off sweep does), and notes are
 *   editable until then. After sign-off the database refuses in-place edits;
 *   corrections are append-only addenda.
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
    const doctor = await doctorsService.getMyDoctorProfile(userId).catch(() => null);
    if (doctor && doctor.id === consultation.appointment.doctorProfileId) {
      return decryptConsultation(consultation);
    }
    const patient = await patientsService.getMyPatientProfile(userId).catch(() => null);
    if (patient && patient.id === consultation.appointment.patientProfileId) {
      return decryptConsultation(consultation);
    }
  }
  throw new HttpError(403, 'You do not have access to this consultation.');
}

/** Decrypts the note and every addendum body. The stored envelopes never
 * leave this module. */
function decryptConsultation<
  T extends { notes: string | null; addenda: { body: string }[] },
>(consultation: T) {
  return {
    ...consultation,
    notes: decryptField(consultation.notes),
    addenda: consultation.addenda.map((addendum) => ({
      ...addendum,
      body: decryptField(addendum.body) ?? '',
    })),
  };
}

/** The sign-off/edit/addendum routes are restricted to the authoring doctor:
 * the doctor the underlying appointment is against. A stranger gets 403 (the
 * consultation's existence is already implied by its id, matching
 * getConsultation); an unknown id gets 404. */
async function requireTreatingDoctor(userId: string, consultationId: string) {
  const consultation = await consultationsRepo.findConsultationById(prisma, consultationId);
  if (!consultation) throw new HttpError(404, 'Consultation not found.');
  const doctor = await doctorsService.getMyDoctorProfile(userId).catch(() => null);
  if (!doctor || !consultation.appointment || doctor.id !== consultation.appointment.doctorProfileId) {
    throw new HttpError(403, 'Only the treating doctor can change this consultation.');
  }
  return consultation;
}

/**
 * Issue #64: edit the note while it is still unsigned. The conditional
 * UPDATE (`WHERE signedAt IS NULL`) is the guarantee — a concurrent sign-off
 * wins and this answers 409 instead of rewriting a signed legal record.
 */
export async function updateConsultationNotes(
  actor: auditService.AuditActor,
  consultationId: string,
  notes: string,
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  await requireTreatingDoctor(actor.userId, consultationId);

  return prisma.$transaction(async (tx) => {
    const updated = await consultationsRepo.updateNotesIfUnsigned(tx, consultationId, encryptField(notes)!);
    if (updated.count !== 1) {
      throw new HttpError(409, 'This consultation is signed off; add an addendum instead.');
    }
    await auditService.record(tx, actor, {
      entityType: 'Consultation',
      entityId: consultationId,
      action: 'consultation.notes_updated',
      fromState: null,
      toState: null,
    });
    const record = await consultationsRepo.findConsultationById(tx, consultationId);
    if (!record) throw new HttpError(404, 'Consultation not found.');
    return decryptConsultation(record);
  });
}

/**
 * Issue #64: sign the note off. One-shot — a second attempt matches zero
 * rows and answers 409. A record with no notes cannot be signed: there would
 * be nothing to freeze. Signing off freezes `notes` and `outcome` at the DB
 * level (migration `20261118090000_consultation_sign_off`).
 */
export async function signOffConsultation(actor: auditService.AuditActor, consultationId: string) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const consultation = await requireTreatingDoctor(actor.userId, consultationId);
  if (consultation.notes === null) {
    throw new HttpError(409, 'A consultation with no notes cannot be signed off.');
  }

  return prisma.$transaction(async (tx) => {
    const signed = await consultationsRepo.signOffIfUnsigned(tx, consultationId);
    if (signed.count !== 1) {
      throw new HttpError(409, 'This consultation is already signed off.');
    }
    await auditService.record(tx, actor, {
      entityType: 'Consultation',
      entityId: consultationId,
      action: 'consultation.signed_off',
      fromState: 'unsigned',
      toState: 'signed',
    });
    const record = await consultationsRepo.findConsultationById(tx, consultationId);
    if (!record) throw new HttpError(404, 'Consultation not found.');
    return decryptConsultation(record);
  });
}

/**
 * Issue #64: post-sign-off correction. Append-only and attributed; the
 * original note is never touched. Only the authoring doctor may add one, and
 * only after sign-off (before it, edit the note instead).
 */
export async function addConsultationAddendum(
  actor: auditService.AuditActor,
  consultationId: string,
  body: string,
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const consultation = await requireTreatingDoctor(actor.userId, consultationId);
  if (consultation.signedAt === null) {
    throw new HttpError(409, 'Addenda can only be added after the consultation is signed off.');
  }

  return prisma.$transaction(async (tx) => {
    const addendum = await consultationsRepo.createAddendum(tx, {
      consultationId,
      authorDoctorId: consultation.appointment!.doctorProfileId,
      body: encryptField(body)!,
    });
    await auditService.record(tx, actor, {
      entityType: 'Consultation',
      entityId: consultationId,
      action: 'consultation.addendum_added',
      fromState: null,
      toState: addendum.id,
    });
    return { ...addendum, body };
  });
}

/**
 * Issue #64: auto sign-off. Notes must not stay editable forever, so an
 * unsigned consultation whose appointment completed more than the configured
 * delay ago is signed by the system. Per-row conditional UPDATE inside its
 * own transaction, so this is safe with more than one process running and a
 * doctor's explicit sign-off always wins the race (the loser changes zero
 * rows and writes no event).
 */
export async function autoSignOffDueConsultations(limit = 200): Promise<{ signed: number }> {
  const cutoff = new Date(Date.now() - config.consultations.autoSignOffHours * 60 * 60 * 1000);
  const due = await consultationsRepo.findDueForSignOff(prisma, cutoff, limit);

  let signed = 0;
  for (const { id } of due) {
    const changed = await prisma.$transaction(async (tx) => {
      const result = await consultationsRepo.signOffIfUnsigned(tx, id);
      if (result.count !== 1) return false;
      await auditService.record(tx, auditService.SYSTEM_ACTOR, {
        entityType: 'Consultation',
        entityId: id,
        action: 'consultation.auto_signed_off',
        fromState: 'unsigned',
        toState: 'signed',
      });
      return true;
    });
    if (changed) signed += 1;
  }
  return { signed };
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
