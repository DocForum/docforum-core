// consultations services — the only exported surface other modules (and this
// module's own controllers) may call.
//
// Issue #64: a consultation is a draft until sign-off, then immutable with
// append-only addenda. Authorisation is deliberately narrow — the authoring
// doctor is the only account that can read, edit, sign off or add addenda
// until the appointment/patient link exists (Phase 2 #4). That's a flagged
// limitation, not an assumption that others shouldn't see it (PRD §7).
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import * as doctorsService from '../../doctors/services';
import * as appointmentsService from '../../appointments/services';
import * as consultationsRepo from '../repositories';
import type { ConsultationOutcome } from '@prisma/client';

export interface ConsultationReadModel {
  id: string;
  doctorProfileId: string;
  notes: string | null;
  outcome: ConsultationOutcome | null;
  signedAt: Date | null;
  createdAt: Date;
  /** false once signed off — clients should hide the note editor. */
  editable: boolean;
  addenda: { id: string; body: string; authorDoctorProfileId: string; createdAt: Date }[];
}

function toReadModel(consultation: {
  id: string;
  doctorProfileId: string;
  notes: string | null;
  outcome: ConsultationOutcome | null;
  signedAt: Date | null;
  createdAt: Date;
  addenda: { id: string; body: string; authorDoctorProfileId: string; createdAt: Date }[];
}): ConsultationReadModel {
  return {
    id: consultation.id,
    doctorProfileId: consultation.doctorProfileId,
    notes: consultation.notes,
    outcome: consultation.outcome,
    signedAt: consultation.signedAt,
    createdAt: consultation.createdAt,
    // Signed-off notes are immutable, but addenda are still allowed — the
    // note body itself is what stops being editable.
    editable: consultation.signedAt === null,
    addenda: consultation.addenda,
  };
}

/** The caller's own doctor profile (cross-module access through the doctors
 * module's service interface, never its repository). */
async function requireAuthoringDoctor(userId: string) {
  return doctorsService.getMyDoctorProfile(userId);
}

async function requireOwnConsultation(userId: string, consultationId: string) {
  const consultation = await consultationsRepo.findConsultationById(consultationId);
  if (!consultation) throw new HttpError(404, 'Consultation not found.');

  const doctorProfile = await requireAuthoringDoctor(userId);
  // Same 404 whether it doesn't exist or belongs to another doctor — a
  // consultation id shouldn't confirm whose patient thread it is.
  if (consultation.doctorProfileId !== doctorProfile.id) {
    throw new HttpError(404, 'Consultation not found.');
  }

  return consultation;
}

export async function createConsultation(
  userId: string,
  input: { appointmentId: string; notes?: string; outcome?: ConsultationOutcome },
): Promise<ConsultationReadModel> {
  // The appointment is what a consultation closes (one per appointment,
  // unique). Resolved through the appointments module's service, which
  // also proves the appointment belongs to this doctor — never by reading
  // another module's table (AGENTS.md hard rule 4).
  const appointment = await appointmentsService.getDoctorAppointmentContext(userId, input.appointmentId);
  const consultation = await consultationsRepo.createConsultation({
    appointmentId: appointment.id,
    doctorProfileId: appointment.doctorProfileId,
    notes: input.notes,
    outcome: input.outcome,
  });
  return toReadModel({ ...consultation, addenda: [] });
}

export async function getConsultation(userId: string, consultationId: string): Promise<ConsultationReadModel> {
  return toReadModel(await requireOwnConsultation(userId, consultationId));
}

/**
 * Edits a draft. A signed-off consultation is immutable at two levels: this
 * refuses with a 409, and the DB trigger rejects the UPDATE even if this is
 * bypassed.
 */
export async function updateConsultation(
  userId: string,
  consultationId: string,
  input: { notes?: string; outcome?: ConsultationOutcome },
): Promise<ConsultationReadModel> {
  const consultation = await requireOwnConsultation(userId, consultationId);
  if (consultation.signedAt) {
    throw new HttpError(
      409,
      'This consultation is signed off and can no longer be edited. Add an addendum instead.',
    );
  }

  const result = await consultationsRepo.updateConsultationDraft(consultationId, input);
  // Lost a race against auto sign-off / a concurrent sign-off between the
  // read above and this write.
  if (result.count !== 1) {
    throw new HttpError(409, 'This consultation was signed off while you were editing it.');
  }

  return toReadModel(await requireOwnConsultation(userId, consultationId));
}

export async function signOffConsultation(
  userId: string,
  consultationId: string,
  at: Date = new Date(),
): Promise<ConsultationReadModel> {
  await requireOwnConsultation(userId, consultationId);

  const result = await consultationsRepo.signOffConsultation(consultationId, at);
  if (result.count !== 1) throw new HttpError(409, 'This consultation is already signed off.');

  return toReadModel(await requireOwnConsultation(userId, consultationId));
}

/**
 * Post-sign-off corrections. Only the authoring doctor may add one, and only
 * to a signed-off consultation — before sign-off the note itself is still
 * editable, so an addendum would just be a confusing second draft.
 */
export async function addAddendum(
  userId: string,
  consultationId: string,
  body: string,
): Promise<ConsultationReadModel> {
  const consultation = await requireOwnConsultation(userId, consultationId);

  if (!consultation.signedAt) {
    throw new HttpError(409, 'Addenda are only for signed-off consultations — edit the note directly while it is a draft.');
  }

  await consultationsRepo.createAddendum({
    consultationId,
    authorDoctorProfileId: consultation.doctorProfileId,
    body,
  });

  return toReadModel(await requireOwnConsultation(userId, consultationId));
}

/**
 * Signs off every draft older than the configured window. Runs from the
 * interval job in src/jobs (kept as a plain interval per
 * ARCHITECTURE.md §6.3.2 — no queue until a real job needs one).
 *
 * Caveat, flagged: the window is measured from `createdAt`, not from the
 * appointment's completion time — `Appointment` has no completed-at stamp
 * yet (#4 owns the appointment lifecycle).
 */
export async function autoSignOffDueConsultations(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - config.consultations.autoSignoffHours * 60 * 60 * 1000);
  const due = await consultationsRepo.findConsultationsDueForAutoSignOff(cutoff);

  let signedOff = 0;
  for (const consultation of due) {
    const result = await consultationsRepo.signOffConsultation(consultation.id, now);
    signedOff += result.count;
  }
  return signedOff;
}
