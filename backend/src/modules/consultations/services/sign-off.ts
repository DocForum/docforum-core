import { config } from '../../../config';
import { prisma, runWithRlsBypassContext } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { decryptField, encryptField } from '../../../utils/field-encryption';
import * as auditService from '../../audit/services';
import * as doctorsService from '../../doctors/services';
import * as consultationsRepo from '../repositories';

async function assertAuthoringDoctor(userId: string, consultationId: string) {
  const consultation = await consultationsRepo.findConsultationById(prisma, consultationId);
  if (!consultation) throw new HttpError('CONSULTATION_NOT_FOUND', 'Consultation not found.');

  const doctor = await doctorsService
    .getDoctorProfileById(consultation.appointment.doctorProfileId)
    .catch(() => null);
  if (!doctor || doctor.userId !== userId) {
    throw new HttpError('NOT_TREATING_DOCTOR', 'Only the treating doctor can change this note.');
  }
  return consultation;
}

async function loadView(consultationId: string) {
  const consultation = await consultationsRepo.findConsultationById(prisma, consultationId);
  if (!consultation) throw new HttpError('CONSULTATION_NOT_FOUND', 'Consultation not found.');
  return viewConsultation(consultation);
}

function viewConsultation(
  consultation: NonNullable<Awaited<ReturnType<typeof consultationsRepo.findConsultationById>>>,
) {
  return {
    ...consultation,
    notes: decryptField(consultation.notes) ?? null,
    addenda: consultation.addenda.map((addendum) => ({
      id: addendum.id,
      authorUserId: addendum.authorUserId,
      body: decryptField(addendum.body) ?? '',
      createdAt: addendum.createdAt,
    })),
  };
}

/** Issue #64: notes stay editable until sign-off. The conditional UPDATE
 * (`WHERE signedAt IS NULL`) is the app-level guard; a DB trigger rejects a
 * direct UPDATE after sign-off even through Prisma. */
export async function updateNotes(actor: auditService.AuditActor, consultationId: string, notes: string) {
  if (!actor.userId) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const consultation = await assertAuthoringDoctor(actor.userId, consultationId);
  if (consultation.signedAt) {
    throw new HttpError('CONSULTATION_NOTE_SIGNED', 'This note is signed and can no longer be edited; add an addendum instead.');
  }

  const result = await consultationsRepo.updateNotesIfUnsigned(prisma, consultationId, encryptField(notes)!);
  if (result.count !== 1) {
    throw new HttpError('CONSULTATION_NOTE_SIGNED', 'This note is signed and can no longer be edited; add an addendum instead.');
  }
  return loadView(consultationId);
}

/** Sign-off is once-only; a second attempt is a 409, not a silent no-op. */
export async function signOff(actor: auditService.AuditActor, consultationId: string) {
  if (!actor.userId) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const consultation = await assertAuthoringDoctor(actor.userId, consultationId);
  if (consultation.signedAt) {
    throw new HttpError('CONSULTATION_ALREADY_SIGNED', 'This consultation note is already signed.');
  }

  await prisma.$transaction(async (tx) => {
    const result = await consultationsRepo.markSignedIfUnsigned(tx, consultationId, new Date());
    if (result.count !== 1) {
      throw new HttpError('CONSULTATION_ALREADY_SIGNED', 'This consultation note is already signed.');
    }
    await auditService.record(tx, actor, {
      entityType: 'Consultation',
      entityId: consultationId,
      action: 'consultation.signed',
      fromState: null,
      toState: 'signed',
    });
  });

  return loadView(consultationId);
}

/** Post-sign-off corrections are new append-only rows. The authoring doctor
 * is the only writer, and only after signing — before that the note itself is
 * still editable, so an addendum would duplicate it. */
export async function addAddendum(actor: auditService.AuditActor, consultationId: string, body: string) {
  if (!actor.userId) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const consultation = await assertAuthoringDoctor(actor.userId, consultationId);
  if (!consultation.signedAt) {
    throw new HttpError(
      'CONSULTATION_NOTE_NOT_SIGNED',
      'Sign the consultation note before adding an addendum; it is still editable.');
  }

  await prisma.$transaction(async (tx) => {
    const addendum = await consultationsRepo.createAddendum(tx, {
      consultationId,
      authorUserId: actor.userId!,
      body: encryptField(body) ?? '',
    });
    await auditService.record(tx, actor, {
      entityType: 'Consultation',
      entityId: consultationId,
      action: 'consultation.addendum_added',
      fromState: null,
      toState: null,
      metadata: { addendumId: addendum.id },
    });
  });

  return loadView(consultationId);
}

/** Auto sign-off (issue #64): notes not edited within the configured grace
 * period are signed by the sweep so they don't stay editable forever. */
export async function autoSignOffOverdue(now = new Date()) {
  const cutoff = new Date(now.getTime() - config.consultations.autoSignOffHours * 60 * 60 * 1000);
  // Trusted maintenance work, not a patient request: run under the dedicated
  // RLS bypass role (docs/adr/0014), or Consultation's UPDATE policy would
  // silently match zero rows.
  const result = await runWithRlsBypassContext(() =>
    consultationsRepo.signOffUnsignedClosedBefore(prisma, cutoff, now),
  );
  return { signed: result.count };
}
