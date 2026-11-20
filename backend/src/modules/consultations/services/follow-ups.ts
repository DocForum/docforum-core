import type { FollowUpStatus, Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { decryptField } from '../../../utils/field-encryption';
import * as appointmentsService from '../../appointments/services';
import * as auditService from '../../audit/services';
import * as patientsService from '../../patients/services';
import * as consultationsRepo from '../repositories';

export interface FollowUpWindowInput {
  windowStart: Date;
  windowEnd: Date;
}

function viewFollowUp(record: {
  id: string;
  consultationId: string;
  doctorProfileId: string;
  patientProfileId: string;
  notesSnapshot: string | null;
  intakeFormId: string | null;
  windowStart: Date;
  windowEnd: Date;
  status: FollowUpStatus;
  bookedAppointmentId: string | null;
  createdAt: Date;
}) {
  return {
    id: record.id,
    consultationId: record.consultationId,
    doctorProfileId: record.doctorProfileId,
    patientProfileId: record.patientProfileId,
    notesSnapshot: decryptField(record.notesSnapshot) ?? null,
    intakeFormId: record.intakeFormId,
    windowStart: record.windowStart,
    windowEnd: record.windowEnd,
    status: record.status,
    bookedAppointmentId: record.bookedAppointmentId,
    createdAt: record.createdAt,
  };
}

/**
 * Issue #63: created in the same transaction that closes the consultation as
 * `follow_up_needed`. The note is copied, not pointed at — the same immutable
 * snapshot rule referrals follow. `intakeFormId` is the patient's latest
 * intake at that moment; Appointment has no intake FK yet (issue #2), so the
 * follow-up carries the link itself.
 */
export async function createFollowUpRequestForConsultation(
  tx: Prisma.TransactionClient,
  input: FollowUpWindowInput & {
    consultationId: string;
    doctorProfileId: string;
    patientProfileId: string;
    notesCiphertext: string | null;
  },
) {
  const intake = await consultationsRepo.findLatestIntakeForPatient(tx, input.patientProfileId);
  return consultationsRepo.createFollowUpRequest(tx, {
    consultationId: input.consultationId,
    doctorProfileId: input.doctorProfileId,
    patientProfileId: input.patientProfileId,
    notesSnapshot: input.notesCiphertext,
    intakeFormId: intake?.id ?? null,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
  });
}

/** The patient's own follow-ups, newest first, snapshots decrypted. Expired
 * ones stay visible (issue #63). */
export async function listMyFollowUps(userId: string, status?: FollowUpStatus) {
  const patient = await patientsService.getMyPatientProfile(userId);
  const rows = await consultationsRepo.findFollowUpsForPatient(prisma, patient.id, status);
  return rows.map(viewFollowUp);
}

/**
 * Books an open follow-up. The booking reuses the standard concurrency-safe
 * path (`appointmentsService.bookForFollowUp` → `claimOpenSlot`) — no
 * shortcut write to the appointment table. The follow-up itself is claimed
 * with one conditional UPDATE, so two concurrent accepts produce one
 * appointment. Everything commits together.
 */
export async function bookFollowUp(
  actor: auditService.AuditActor,
  followUpId: string,
  availabilitySlotId: string,
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const patient = await patientsService.getMyPatientProfile(actor.userId);

  return prisma.$transaction(async (tx) => {
    const followUp = await consultationsRepo.findFollowUpById(tx, followUpId);
    if (!followUp) throw new HttpError(404, 'Follow-up request not found.');
    if (followUp.patientProfileId !== patient.id) {
      throw new HttpError(403, 'This follow-up request does not belong to you.');
    }
    if (followUp.status === 'expired') {
      throw new HttpError(409, 'This follow-up request has expired.', 'FOLLOW_UP_EXPIRED');
    }
    if (followUp.status !== 'open') {
      throw new HttpError(409, 'This follow-up request has already been booked.', 'FOLLOW_UP_ALREADY_BOOKED');
    }
    if (Date.now() > followUp.windowEnd.getTime()) {
      throw new HttpError(409, 'This follow-up request has expired.', 'FOLLOW_UP_EXPIRED');
    }

    const claimed = await consultationsRepo.claimOpenFollowUp(tx, followUpId);
    if (claimed.count !== 1) {
      throw new HttpError(409, 'This follow-up request has already been booked.', 'FOLLOW_UP_ALREADY_BOOKED');
    }

    const appointment = await appointmentsService.bookForFollowUp(
      tx,
      {
        patientProfileId: patient.id,
        doctorProfileId: followUp.doctorProfileId,
        availabilitySlotId,
      },
      actor,
    );

    await consultationsRepo.attachBookedAppointment(tx, followUpId, appointment.id);

    return { appointment, followUp: viewFollowUp({ ...followUp, status: 'booked', bookedAppointmentId: appointment.id }) };
  });
}

/** Expiry sweep (issue #63): one conditional UPDATE, safe to run in more than
 * one process. Expired requests stay listed as `expired`. */
export async function expireOpenFollowUps(now = new Date()) {
  const result = await consultationsRepo.expireFollowUpsPastWindow(prisma, now);
  return { expired: result.count };
}
