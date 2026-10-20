import { Prisma, type ConsultationOutcome } from '@prisma/client';
import { HttpError } from '../../../http-error';
import { prisma } from '../../../db/prisma-client';
import * as consultationsRepo from '../repositories';
import * as appointmentsService from '../../appointments/services';
import * as auditService from '../../audit/services';
import { decryptField, encryptField } from '../../../utils/field-encryption';

/**
 * Close a consultation for the caller's own appointment, exactly once.
 *
 * - The one-consultation-per-appointment guarantee is enforced at the DB
 *   level by `Consultation.appointmentId UNIQUE`, not by a check-then-write
 *   here. Two concurrent closes both reach the INSERT; exactly one commits,
 *   the loser gets P2002 and a 409. The read below only exists for a nicer
 *   message on the common (sequential) case.
 * - "Doctor-only, own-appointment-only" is enforced by reading the
 *   Appointment through appointmentsService (the only legal cross-module
 *   seam per AGENTS.md hard rule 4): that service returns null for an
 *   appointment that doesn't exist or isn't the caller's, and this service
 *   answers 404 either way so it never reveals that someone else's
 *   appointment exists.
 * - Single-use in v1: no amendments/edits. That is an explicit open
 *   question (ROADMAP.md Phase 2), not an assumption we silently bake in.
 * - `notes` is clinical free text and is stored as an AES-256-GCM envelope
 *   (ARCHITECTURE.md §4.3 / §2 — Phase 8 issue #46), never plaintext. The
 *   ciphertext is therefore unsearchable by design; a future search feature
 *   has to decrypt in the app layer. No read path exists yet, so this
 *   is the first writer to that convention.
 */
export async function closeConsultation(
  actor: auditService.AuditActor,
  appointmentId: string,
  outcome: ConsultationOutcome,
  notes: string,
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');

  const appointment = await appointmentsService.getAppointmentForDoctor(actor.userId, appointmentId);
  if (!appointment) {
    throw new HttpError(404, 'Appointment not found.');
  }

  const existing = await consultationsRepo.findConsultationByAppointmentId(appointmentId);
  if (existing) {
    throw new HttpError(409, 'A consultation for this appointment has already been closed.');
  }

  let consultation;
  try {
    consultation = await prisma.$transaction(async (tx) => {
      const record = await consultationsRepo.createConsultation(tx, {
        appointmentId,
        outcome,
        notes: encryptField(notes) as string,
      });

      // Phase 8 audit trail (issue #43): the state change and its event commit
      // together, so an event exists iff the consultation was actually closed.
      await auditService.record(tx, actor, {
        entityType: 'Consultation',
        entityId: record.id,
        action: 'consultation.closed',
        fromState: null,
        toState: outcome,
        metadata: { appointmentId },
      });

      return record;
    });
  } catch (err) {
    // The DB unique constraint is the actual guarantee; translate the race's
    // loser into the same 409 the pre-check produces.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, 'A consultation for this appointment has already been closed.');
    }
    throw err;
  }

  // The caller just wrote these notes, so hand them back in plaintext rather
  // than leaking the stored ciphertext envelope.
  return { consultation: { ...consultation, notes: decryptField(consultation.notes) }, appointment };
}
