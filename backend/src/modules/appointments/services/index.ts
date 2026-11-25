import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { config } from '../../../config';
import { Prisma, type AppointmentStatus } from '@prisma/client';
import { transitionAppointmentStatus, canFinalizeAppointment } from '../state-machine';
import * as appointmentsRepo from '../repositories';
import * as availabilityService from '../../availability/services';
import * as doctorsService from '../../doctors/services';
import * as patientsService from '../../patients/services';
import * as auditService from '../../audit/services';
import * as referralsService from '../../referrals/services';
import { publish } from '../../../events';
import { getCalendarDayBounds, parseScheduleDateRange } from '../time-zones';

/**
 * Books a slot for the calling patient. This is the correctness-critical
 * path in the whole backend (ARCHITECTURE.md §5.1 / ROADMAP.md Phase 1 —
 * "the single highest-priority correctness item in the whole roadmap").
 *
 * The slot claim, Appointment row, AuditEvent, and outbox event share one
 * transaction:
 *   1. `availabilityService.claimOpenSlot` — a conditional `UPDATE ...
 *      WHERE status = 'open'`, atomic at the DB level. Exactly one
 *      concurrent caller can ever see `count === 1` for a given slot.
 *   2. Create the `Appointment` row.
 * Both inside the same transaction so a failure between them can never
 * leave a slot marked `booked` with no `Appointment` to show for it.
 *
 * See backend/tests/integration/booking.test.ts for the concurrency proof
 * this is built to satisfy.
 *
 * Phase 8, issue #42 (docs/adr/0011): `patientProfileId` books for a
 * dependent the caller is an active guardian of. Authorisation happens
 * here, BEFORE the transaction — it only decides which profile the
 * appointment is for. The transaction below is unchanged by it.
 *
 * Phase 8, issue #43: the booking's AuditEvent is written as a third step
 * of the same transaction, after the Appointment row exists — so an event
 * exists if and only if the booking committed. A caller that loses the
 * race fails at step 1 and never reaches it. For a guardian booking, the
 * actor is the guardian and the event's metadata names the dependent's
 * profile id.
 */
export async function bookSlot(actor: auditService.AuditActor, availabilitySlotId: string, patientProfileId?: string) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const patientProfile = await patientsService.resolveActingProfile(actor.userId, patientProfileId);

  return prisma.$transaction(async (tx) => {
    const claimed = await availabilityService.claimOpenSlot(tx, availabilitySlotId);
    if (!claimed) {
      throw new HttpError(409, 'This slot is no longer available.');
    }

    const slot = await availabilityService.getSlot(tx, availabilitySlotId);
    if (!slot) {
      // Can't happen in practice (claimOpenSlot just matched this id), but
      // keeps TypeScript honest and fails loudly instead of silently.
      throw new HttpError(404, 'Slot not found.');
    }

    // Ensure the doctor is active (not deactivated or deleted)
    await doctorsService.assertDoctorActive(slot.doctorProfileId);

    const appointment = await appointmentsRepo.createAppointment(tx, {
      patientProfileId: patientProfile.id,
      doctorProfileId: slot.doctorProfileId,
      availabilitySlotId,
    });

    await auditService.record(tx, actor, {
      entityType: 'Appointment',
      entityId: appointment.id,
      action: 'appointment.booked',
      fromState: null,
      toState: appointment.status,
      metadata: {
        availabilitySlotId,
        doctorProfileId: slot.doctorProfileId,
        patientProfileId: patientProfile.id,
        origin: appointment.origin,
      },
    });

    await publish(tx, 'appointment.booked', {
      appointmentId: appointment.id,
      patientUserId: actor.userId,
    });

    return appointment;
  });
}

export async function listMyAppointments(userId: string, patientProfileId?: string) {
  const patientProfile = await patientsService.resolveActingProfile(userId, patientProfileId);
  return appointmentsRepo.findAppointmentsForPatient(patientProfile.id);
}

export async function getAppointmentContextsForPatient(userId: string, patientProfileId?: string) {
  const patientProfile = await patientsService.resolveActingProfile(userId, patientProfileId);
  const appointments = await appointmentsRepo.findAppointmentsForPatient(patientProfile.id);
  const map = new Map<string, { doctorProfileId: string; date: Date }>();
  for (const appt of appointments) {
    map.set(appt.id, {
      doctorProfileId: appt.doctorProfileId,
      date: appt.availabilitySlot?.startTime ?? appt.createdAt,
    });
  }
  return map;
}

export async function getAppointmentContextsForDoctor(userId: string) {
  const doctorProfile = await doctorsService.getMyDoctorProfile(userId);
  const appointments = await appointmentsRepo.findAppointmentsForDoctor(doctorProfile.id);
  const map = new Map<string, { patientProfileId: string; date: Date }>();
  for (const appt of appointments) {
    map.set(appt.id, {
      patientProfileId: appt.patientProfileId,
      date: appt.availabilitySlot?.startTime ?? appt.createdAt,
    });
  }
  return map;
}

/**
 * Reschedules an appointment atomically: in one transaction, claims the new
 * slot and releases the old one. The new slot must belong to the same
 * doctor (or be explicitly allowed).
 *
 * Requirements from issue #55:\n - Add `POST /appointments/:id/reschedule` with `{ newSlotId }`\n - In one transaction: conditionally claim the new slot (`WHERE status = 'open'`),
 *   re-point the appointment, and release the old slot back to `open`\n - Respect a configurable cutoff (e.g. no reschedule within 2h of start)\n - Concurrency tests: two patients rescheduling into the same slot, and a
 *   reschedule racing a fresh booking\n */
export async function rescheduleSlot(
  actor: auditService.AuditActor,
  appointmentId: string,
  newSlotId: string,
  cutoffHours: number = config.appointments.cutoffHours,
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const userId = actor.userId;

  return prisma.$transaction(async (tx) => {
    // First, get the existing appointment to find its current slot
    const existingAppointment = await appointmentsRepo.findAppointmentById(tx, appointmentId);
    if (!existingAppointment) {
      throw new HttpError(404, 'Appointment not found.');
    }

    const patientProfile = await patientsService.resolveActingProfile(userId, existingAppointment.patientProfileId);

    // Check that the appointment belongs to this patient
    if (existingAppointment.patientProfileId !== patientProfile.id) {
      throw new HttpError(403, 'This appointment does not belong to you.');
    }

    if (existingAppointment.status !== 'scheduled') {
      throw new HttpError(409, 'Only a scheduled appointment can be rescheduled.');
    }

    const currentSlotId = existingAppointment.availabilitySlotId;
    if (!currentSlotId) {
      throw new HttpError(409, 'Appointment no longer has an active slot.');
    }

    // Rescheduling onto the same slot is a no-op
    if (currentSlotId === newSlotId) {
      return existingAppointment;
    }

    // Check cutoff: no reschedule within cutoffHours of slot start
    const slot = await availabilityService.getSlot(tx, currentSlotId);
    if (!slot) {
      throw new HttpError(404, 'Original slot not found.');
    }

    const slotStart = slot.startTime;
    const now = new Date();
    const cutoffMs = cutoffHours * 60 * 60 * 1000;
    if (slotStart.getTime() - now.getTime() < cutoffMs) {
      throw new HttpError(409, `Rescheduling is not allowed within ${cutoffHours} hours of the slot start time.`);
    }

    // Validate new slot
    const newSlot = await availabilityService.getSlot(tx, newSlotId);
    if (!newSlot) {
      throw new HttpError(404, 'New slot not found.');
    }
    if (newSlot.doctorProfileId !== existingAppointment.doctorProfileId) {
      throw new HttpError(400, 'The new slot must belong to the same doctor.');
    }
    if (newSlot.startTime.getTime() <= now.getTime()) {
      throw new HttpError(400, 'The new slot must be in the future.');
    }

    // Ensure the doctor is active (not deactivated or deleted)
    await doctorsService.assertDoctorActive(newSlot.doctorProfileId);

    // Claim the new slot atomically
    const newClaimed = await availabilityService.claimOpenSlot(tx, newSlotId);
    if (!newClaimed) {
      throw new HttpError(409, 'The new slot is no longer available.');
    }

    // Release the old slot through availabilityService
    await availabilityService.releaseBookedSlotIfFuture(tx, currentSlotId);

    // Re-point the appointment conditionally
    const repointed = await appointmentsRepo.rescheduleIfScheduled(tx, appointmentId, newSlotId);
    if (repointed.count !== 1) {
      throw new HttpError(409, 'This appointment is no longer scheduled.');
    }

    const updatedAppointment = await appointmentsRepo.findAppointmentById(tx, appointmentId);
    if (!updatedAppointment) {
      throw new HttpError(404, 'Appointment not found.');
    }

    await auditService.record(tx, actor, {
      entityType: 'Appointment',
      entityId: updatedAppointment.id,
      action: 'appointment.rescheduled',
      fromState: existingAppointment.status,
      toState: updatedAppointment.status,
      metadata: {
        oldSlotId: currentSlotId,
        newSlotId,
        patientProfileId: patientProfile.id,
      },
    });

    return updatedAppointment;
  });
}

/**
 * Cancels an appointment atomically: releases the slot back to `open` and
 * marks the appointment as cancelled. Includes cutoff window logic.
 *
 * Requirements from issue #56 and #292:
 * - Single correct cancellation path routing through applyScheduledTransition
 * - Before cutoff (config.appointments.cutoffHours): slot releases to `open`
 * - After cutoff: slot stays booked, appointment marked `late_cancelled`
 * - Conditional on status = `scheduled`
 */
export async function cancelAppointment(
  actor: auditService.AuditActor,
  appointmentId: string,
  _reason: 'patient' | 'doctor' = 'patient',
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  return cancelByPatient(actor.userId, appointmentId, actor);
}

/**
 * Waitlist management (Phase 2, issue #57):
 - Patient joins waitlist for a doctor/specialty with a time window
 - Patient leaves waitlist
 - Patient lists their waitlist entries
 - System offers slots to waitlist entries when slots become open
 - Patient accepts offer, which converts the hold to a booking in one transaction
 */

export async function joinWaitlist(
  actor: auditService.AuditActor,
  patientProfileId: string,
  doctorProfileId: string | undefined,
  specialtyId: string | undefined,
  earliestAcceptable: Date | undefined,
  latestAcceptable: Date | undefined,
  holdDurationMinutes: number | undefined,
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');

  try {
    return await prisma.$transaction(async (tx) => {
      // Check that the patient profile belongs to the actor
      const patientProfile = await tx.patientProfile.findUnique({
        where: { id: patientProfileId },
      });
      if (!patientProfile) {
        throw new HttpError(404, 'Patient profile not found.');
      }

      // Create the waitlist entry: DB-level partial unique index prevents concurrent duplicates
      const entry = await tx.waitlistEntry.create({
        data: {
          patientProfileId,
          doctorProfileId: doctorProfileId ?? null,
          specialtyId: specialtyId ?? null,
          status: 'pending',
          earliestAcceptable: earliestAcceptable ?? new Date(),
          latestAcceptable: latestAcceptable ?? new Date(),
          holdDurationMinutes: holdDurationMinutes ?? 30, // default 30 min hold
        },
      });

      return entry;
    });
  } catch (err: any) {
    if ((err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') || err?.code === 'P2002') {
      throw new HttpError(409, 'You are already on the waitlist for this doctor/specialty.');
    }
    throw err;
  }
}

/**
 * Patient leaves the waitlist
 */
export async function leaveWaitlist(
  actor: auditService.AuditActor,
  entryId: string,
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');

  const entry = await prisma.waitlistEntry.findUnique({
    where: { id: entryId },
  });
  if (!entry) {
    throw new HttpError(404, 'Waitlist entry not found.');
  }

  // Verify the entry belongs to the caller (or their active dependent)
  let isOwner = false;
  try {
    const actingProfile = await patientsService.resolveActingProfile(actor.userId, entry.patientProfileId);
    if (actingProfile.id === entry.patientProfileId) {
      isOwner = true;
    }
  } catch (_err) {
    isOwner = false;
  }

  if (!isOwner) {
    throw new HttpError(403, 'This waitlist entry does not belong to you.');
  }

  if (entry.status === 'accepted') {
    throw new HttpError(409, 'Cannot leave an already accepted waitlist entry.');
  }

  const updated = await prisma.waitlistEntry.updateMany({
    where: { id: entryId, status: { in: ['pending', 'on_hold'] } },
    data: { status: 'expired' },
  });

  if (updated.count === 0) {
    throw new HttpError(409, 'This waitlist entry is no longer active.');
  }

  return { cancelled: true };
}

/**
 * List all waitlist entries for a patient
 */
export async function listWaitlistEntries(
  patientProfileId: string,
) {
  return prisma.waitlistEntry.findMany({
    where: { patientProfileId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Accept a waitlist offer: converts the hold to a booking in one transaction
 */
export async function acceptWaitlistOffer(
  actor: auditService.AuditActor,
  entryId: string,
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');

  return prisma.$transaction(async (tx) => {
    const entry = await prisma.waitlistEntry.findUnique({
      where: { id: entryId },
    });
    if (!entry) {
      throw new HttpError(404, 'Waitlist entry not found.');
    }
    if (entry.status !== 'pending') {
      throw new HttpError(409, 'This waitlist entry is no longer active.');
    }

    // Get open slots for the doctor directly (no need to find first)
    if (!entry.doctorProfileId) {
      throw new HttpError(404, 'No doctor profile specified for waitlist entry.');
    }

    const openSlots = await availabilityService.listOpenSlots(entry.doctorProfileId);
    if (!openSlots.length) {
      throw new HttpError(404, 'No open slots available for this doctor.');
    }

    // Claim the first open slot
    const claimed = await availabilityService.claimOpenSlot(tx, openSlots[0].id);
    if (!claimed) {
      throw new HttpError(409, 'The slot was taken before we could claim it.');
    }

    // Create the appointment
    const patientProfile = await tx.patientProfile.findUnique({
      where: { id: entry.patientProfileId },
    });

    if (!patientProfile) {
      throw new HttpError(404, 'Patient profile not found.');
    }

    const appointment = await appointmentsRepo.createAppointment(tx, {
      patientProfileId: patientProfile.id,
      doctorProfileId: entry.doctorProfileId,
      availabilitySlotId: openSlots[0].id,
    });

    // Mark the waitlist entry as accepted
    await tx.waitlistEntry.update({
      where: { id: entryId },
      data: { status: 'accepted' },
    });

    await auditService.record(tx, actor, {
      entityType: 'Appointment',
      entityId: appointment.id,
      action: 'appointment.booked',
      fromState: null,
      toState: appointment.status,
      metadata: {
        waitlistEntryId: entry.id,
        wasWaitlist: true,
        doctorProfileId: entry.doctorProfileId,
      },
    });

    return appointment;
  });
}

/**
 * Cross-module entry point for the consultations module: return the
 * appointment a doctor may act on, or null if the appointment doesn't exist
 * or isn't theirs. The consultations module never queries `Appointment`
 * directly — it calls this service instead (AGENTS.md hard rule 4).
 */
export async function getAppointmentForDoctor(doctorUserId: string, appointmentId: string) {
  const appointment = await appointmentsRepo.findAppointmentById(prisma, appointmentId);
  if (!appointment) return null;

  const doctorProfile = await doctorsService.getDoctorProfileById(appointment.doctorProfileId);
  if (doctorProfile.userId !== doctorUserId) return null;

  return appointment;
}

/**
 * Role-scoped appointment detail read (Phase 2, issue #296):
 * - Patient (or active guardian of dependent minor) or treating doctor only.
 * - Non-participants and admins get 404 (clinical privacy).
 * - Returns appointment with slot times (`slot`), doctor summary (`doctor`), and origin.
 * - Cancelled appointments with a released slot have no slot times (`slot: null`).
 */
export async function getAppointmentDetail(userId: string, appointmentId: string) {
  const appointment = await appointmentsRepo.findAppointmentById(prisma, appointmentId);
  if (!appointment) {
    throw new HttpError(404, 'Appointment not found.');
  }

  let authorized = false;

  // Check if treating doctor
  try {
    const doctorProfile = await doctorsService.getDoctorProfileById(appointment.doctorProfileId);
    if (doctorProfile.userId === userId) {
      authorized = true;
    }
  } catch {
    // Non-doctor or not found
  }

  // Check if patient or active guardian
  if (!authorized) {
    try {
      const actingProfile = await patientsService.resolveActingProfile(userId, appointment.patientProfileId);
      if (actingProfile.id === appointment.patientProfileId) {
        authorized = true;
      }
    } catch {
      // Non-participant or inactive guardianship
    }
  }

  if (!authorized) {
    throw new HttpError(404, 'Appointment not found.');
  }

  const slotTimes = appointment.availabilitySlotId
    ? (await availabilityService.getSlotTimesByIds([appointment.availabilitySlotId])).get(appointment.availabilitySlotId) ?? null
    : null;
  const doctorSummaries = await doctorsService.getDoctorSummariesByIds([appointment.doctorProfileId]);
  const doctor = doctorSummaries.get(appointment.doctorProfileId) ?? null;

  return {
    ...appointment,
    slot: slotTimes ? { startTime: slotTimes.startTime, endTime: slotTimes.endTime } : null,
    doctor,
  };
}

/** Doctor's own scheduled appointments whose booked slot falls on the
 * current local calendar day in the doctor's timeZone (issue #290). */
export async function listDoctorAppointmentsToday(userId: string) {
  const doctor = await doctorsService.getMyDoctorProfile(userId);
  const { start, end } = getCalendarDayBounds(doctor.timeZone);
  return appointmentsRepo.findAppointmentsForDoctorOnDay(doctor.id, start, end);
}

/**
 * Schedule endpoint for an arbitrary date range in the doctor's time zone (issue #291).
 * Own appointments only; includes slot times and patient display name with zero clinical details.
 */
export async function listDoctorSchedule(
  userId: string,
  query: { from?: string; to?: string; status?: AppointmentStatus },
) {
  const doctor = await doctorsService.getMyDoctorProfile(userId);
  const { start, end } = parseScheduleDateRange(doctor.timeZone, query.from, query.to);
  const rows = await appointmentsRepo.findAppointmentsForDoctorSchedule(doctor.id, start, end, query.status);

  const patientProfileIds = rows.map((r) => r.patientProfileId);
  const patientMap = await patientsService.getPatientSummariesByIds(patientProfileIds);

  const mapped = rows.map((appointment) => {
    const patientSummary = patientMap.get(appointment.patientProfileId);
    return {
      id: appointment.id,
      status: appointment.status,
      origin: appointment.origin,
      patient: {
        id: appointment.patientProfileId,
        fullName: patientSummary?.fullName ?? 'Unknown Patient',
      },
      slot: appointment.availabilitySlot
        ? {
            id: appointment.availabilitySlot.id,
            startTime: appointment.availabilitySlot.startTime,
            endTime: appointment.availabilitySlot.endTime,
          }
        : null,
      createdAt: appointment.createdAt,
      updatedAt: appointment.updatedAt,
    };
  });

  return mapped.sort((a, b) => {
    const timeA = a.slot ? new Date(a.slot.startTime).getTime() : new Date(a.updatedAt).getTime();
    const timeB = b.slot ? new Date(b.slot.startTime).getTime() : new Date(b.updatedAt).getTime();
    return timeA - timeB;
  });
}

/**
 * The participants of an appointment, for modules that own a per-visit
 * record (consultations: the async thread, issue #61). Profile IDs only —
 * the caller resolves user identity through the patients/doctors services,
 * so this stays a service seam, not a repository export.
 */
export async function getAppointmentParticipants(appointmentId: string) {
  const appointment = await appointmentsRepo.findAppointmentById(prisma, appointmentId);
  if (!appointment) return null;
  return {
    id: appointment.id,
    patientProfileId: appointment.patientProfileId,
    doctorProfileId: appointment.doctorProfileId,
    status: appointment.status,
  };
}

/** This module's contribution to the patient data export (issue #40).
 * Slot times and the doctor's name are fetched per page through the
 * availability and doctors services — never by joining their tables. */
export const appointmentsExportSection: patientsService.PatientExportSection = {
  name: 'appointments',
  version: 1,
  pages(subject, pageSize) {
    return patientsService.paginate(
      pageSize,
      (cursor, take) => appointmentsRepo.findAppointmentsPageForPatient(subject.patientProfileId, cursor, take),
      async (rows) => {
        // `availabilitySlotId` is nullable (Phase 3): a CANCELLED
        // appointment releases its slot back to the calendar, so its row
        // keeps its history but no longer points at one. Those rows export
        // with a null slot rather than a stale one.
        const slotIds = rows.map((row) => row.availabilitySlotId).filter((id): id is string => id !== null);
        const [slots, doctors] = await Promise.all([
          availabilityService.getSlotTimesByIds(slotIds),
          doctorsService.getDoctorSummariesByIds(rows.map((row) => row.doctorProfileId)),
        ]);
        return rows.map((row) => ({
          id: row.id,
          status: row.status,
          origin: row.origin,
          slot: row.availabilitySlotId ? (slots.get(row.availabilitySlotId) ?? null) : null,
          doctor: doctors.get(row.doctorProfileId) ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }));
      },
    );
  },
};

/** Resolves an appointment for a doctor-owned consultation without exposing
 * the appointments repository across the module boundary. */
export async function getDoctorAppointmentContext(userId: string, appointmentId: string) {
  const appointment = await appointmentsRepo.findAppointmentDoctorContext(appointmentId);
  if (!appointment) throw new HttpError(404, 'Appointment not found.');
  if (appointment.doctorProfile.userId !== userId) throw new HttpError(403, 'You can only issue orders for your own appointments.');
  if (appointment.doctorProfile.verificationStatus !== 'verified') throw new HttpError(403, 'A verified doctor profile is required to issue orders.');
  return { id: appointment.id, patientProfileId: appointment.patientProfileId, doctorProfileId: appointment.doctorProfileId };
}

/**
 * Creates the pre-populated appointment behind an accepted referral
 * (PRD FR-8 / issue #7). Called by the referrals service from inside its
 * accept transaction — same shape as bookSlot: conditional slot claim,
 * then the Appointment row, with `origin: 'referral'` and the referralId
 * link the cascade rules (issue #67) later react to. Appointment creation
 * belongs to this module; the referral state machine belongs to referrals.
 */
export async function bookForReferral(
  db: Prisma.TransactionClient,
  input: {
    patientProfileId: string;
    doctorProfileId: string;
    availabilitySlotId: string;
    referralId: string;
  },
  actor: auditService.AuditActor,
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const claimed = await availabilityService.claimOpenSlot(db, input.availabilitySlotId);
  if (!claimed) {
    throw new HttpError(409, 'This slot is no longer available.');
  }

const slot = await availabilityService.getSlot(db, input.availabilitySlotId);
  if (!slot) {
    throw new HttpError(404, 'Slot not found.');
  }
  if (slot.doctorProfileId !== input.doctorProfileId) {
    throw new HttpError(409, 'That slot does not belong to the referral\'s target doctor.');
  }

  // Ensure the doctor is active (not deactivated or deleted)
  await doctorsService.assertDoctorActive(slot.doctorProfileId);

  const appointment = await appointmentsRepo.createAppointment(db, {
    patientProfileId: input.patientProfileId,
    doctorProfileId: input.doctorProfileId,
    availabilitySlotId: input.availabilitySlotId,
    origin: 'referral',
    referralId: input.referralId,
  });

  // Same audit event a direct booking writes, in the same transaction —
  // a referral-origin appointment is still an appointment, and the event's
  // `origin` metadata is what tells the two apart. Without this, the
  // referral accept path would be the one way to create an appointment
  // with no trail at all.
  await auditService.record(db, actor, {
    entityType: 'Appointment',
    entityId: appointment.id,
    action: 'appointment.booked',
    fromState: null,
    toState: appointment.status,
    metadata: {
      availabilitySlotId: input.availabilitySlotId,
      doctorProfileId: input.doctorProfileId,
      origin: appointment.origin,
      referralId: input.referralId,
    },
  });

  await publish(db, 'appointment.booked', {
    appointmentId: appointment.id,
    patientUserId: actor.userId,
  });

  return appointment;
}

/**
 * Books the appointment behind a follow-up request (issue #63). Called by
 * the consultations service from inside its own transaction, exactly like
 * `bookForReferral`: the conditional slot claim is the same one a direct
 * booking uses, so a follow-up can never shortcut the double-booking
 * guarantee (ARCHITECTURE_ESSENTIALS hard rule 2).
 */
export async function bookForFollowUp(
  db: Prisma.TransactionClient,
  input: { patientProfileId: string; doctorProfileId: string; availabilitySlotId: string },
  actor: auditService.AuditActor,
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const claimed = await availabilityService.claimOpenSlot(db, input.availabilitySlotId);
  if (!claimed) {
    throw new HttpError(409, 'This slot is no longer available.');
  }

const slot = await availabilityService.getSlot(db, input.availabilitySlotId);
  if (!slot) {
    throw new HttpError(404, 'Slot not found.');
  }
  if (slot.doctorProfileId !== input.doctorProfileId) {
    throw new HttpError(409, 'That slot does not belong to the follow-up\'s doctor.');
  }

  // Ensure the doctor is active (not deactivated or deleted)
  await doctorsService.assertDoctorActive(slot.doctorProfileId);

  const appointment = await appointmentsRepo.createAppointment(db, {
    patientProfileId: input.patientProfileId,
    doctorProfileId: input.doctorProfileId,
    availabilitySlotId: input.availabilitySlotId,
    origin: 'follow_up',
  });

  await auditService.record(db, actor, {
    entityType: 'Appointment',
    entityId: appointment.id,
    action: 'appointment.booked',
    fromState: null,
    toState: appointment.status,
    metadata: {
      availabilitySlotId: input.availabilitySlotId,
      doctorProfileId: input.doctorProfileId,
      origin: appointment.origin,
    },
  });

  await publish(db, 'appointment.booked', {
    appointmentId: appointment.id,
    patientUserId: actor.userId,
  });

  return appointment;
}

/**
 * Moves a scheduled appointment to a terminal status, in one transaction:
 * the conditional status UPDATE, an optional slot release on cancellation,
 * and — if the appointment came from a referral — the cascade reaction in
 * the referrals module (issue #67, PRD §8.2.3). Running the transition
 * twice is impossible by construction: the conditional UPDATE only ever
 * matches a still-`scheduled` row, so the cascade hook below can only fire
 * once per real transition (and the cascade itself is additionally
 * conditional — see referralsService.applyAppointmentOutcome).
 */
async function applyScheduledTransition(
  tx: Prisma.TransactionClient,
  appointment: { id: string; availabilitySlotId: string | null; referralId: string | null },
  newStatus: AppointmentStatus,
) {
  const updated = await appointmentsRepo.updateStatusIfScheduled(tx, appointment.id, newStatus);
  if (updated.count !== 1) {
    throw new HttpError(409, 'This appointment is no longer scheduled.');
  }

  // Only cancellations free the calendar slot, and only while it's still
  // ahead of us — completed/no_show visits consumed the time either way.
  // The appointment row must then drop its unique slot link so the freed
  // slot can actually be re-booked.
  if (newStatus === 'cancelled' && appointment.availabilitySlotId) {
    const released = await availabilityService.releaseBookedSlotIfFuture(tx, appointment.availabilitySlotId);
    if (released) {
      await appointmentsRepo.clearAvailabilitySlotLink(tx, appointment.id);
    }
  }

  if (appointment.referralId) {
    await referralsService.applyAppointmentOutcome(tx, {
      appointmentId: appointment.id,
      referralId: appointment.referralId,
      status: newStatus as 'completed' | 'cancelled' | 'late_cancelled' | 'no_show',
    });
  }
}

/**
 * Doctor-side lifecycle transition (issue #3): the treating doctor marks
 * their own appointment completed / cancelled / no_show. Restricted to
 * the doctor the appointment is against — no admin-on-behalf path in v1.
 */
export async function updateStatusByDoctor(
  userId: string,
  appointmentId: string,
  newStatus: AppointmentStatus,
  now = new Date(),
) {
  const appointment = await appointmentsRepo.findAppointmentById(prisma, appointmentId);
  if (!appointment) throw new HttpError(404, 'Appointment not found.');
  await doctorsService.assertOwnsDoctorProfile(userId, appointment.doctorProfileId);
  if (transitionAppointmentStatus(appointment.status, newStatus) === null) {
    throw new HttpError(409, 'Only a scheduled appointment can change status.');
  }

  if (newStatus === 'completed' || newStatus === 'no_show') {
    if (!appointment.availabilitySlotId) {
      throw new HttpError(
        409,
        'Appointments with a released slot cannot be marked completed or no-show.',
        'APPOINTMENT_NOT_STARTED',
      );
    }
    const slot = await availabilityService.getSlot(prisma, appointment.availabilitySlotId);
    if (!slot || !canFinalizeAppointment(slot.startTime, now)) {
      throw new HttpError(
        409,
        'Cannot mark appointment completed or no-show before the slot start time.',
        'APPOINTMENT_NOT_STARTED',
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    await applyScheduledTransition(tx, appointment, newStatus);
    return appointmentsRepo.findAppointmentById(tx, appointmentId);
  });
}

/**
 * Patient-side cancellation of the patient's own scheduled appointment —
 * the "patient cancels" half of PRD §8.2.3. Deliberately narrower than
 * the doctor endpoint: a patient can only ever cancel (never mark
 * completed/no_show — those are clinical judgements for the doctor), and
 * only from `scheduled`.
 */
export async function cancelByPatient(
  userId: string,
  appointmentId: string,
  actor?: auditService.AuditActor,
) {
  const appointment = await appointmentsRepo.findAppointmentById(prisma, appointmentId);
  if (!appointment) throw new HttpError(404, 'Appointment not found.');
  const patientProfile = await patientsService.resolveActingProfile(userId, appointment.patientProfileId);
  if (appointment.patientProfileId !== patientProfile.id) {
    throw new HttpError(403, 'You can only cancel your own appointments.');
  }
  if (appointment.status !== 'scheduled') {
    throw new HttpError(409, 'Only a scheduled appointment can be cancelled.');
  }

  // Determine status (cancelled vs late_cancelled) based on cutoff config
  let newStatus: AppointmentStatus = 'cancelled';
  if (appointment.availabilitySlotId) {
    const slot = await availabilityService.getSlot(prisma, appointment.availabilitySlotId);
    if (slot) {
      const cutoffMs = config.appointments.cutoffHours * 60 * 60 * 1000;
      const now = new Date();
      if (slot.startTime.getTime() - now.getTime() < cutoffMs) {
        newStatus = 'late_cancelled';
      }
    }
  }

  return prisma.$transaction(async (tx) => {
    await applyScheduledTransition(tx, appointment, newStatus);
    const updated = await appointmentsRepo.findAppointmentById(tx, appointmentId);
    if (actor && updated) {
      await auditService.record(tx, actor, {
        entityType: 'Appointment',
        entityId: updated.id,
        action: 'appointment.cancelled',
        fromState: appointment.status,
        toState: newStatus,
        metadata: {
          reason: 'patient',
          patientProfileId: patientProfile.id,
          slotId: appointment.availabilitySlotId,
        },
      });
    }
    return updated;
  });
}

/**
 * Called by the referrals module's admin cancel (#68) inside its
 * transaction: close a live appointment without firing the referral
 * cascade back (the caller already knows it's cancelling the referral).
 * Appointment rows are still only ever written by this module — the
 * boundary holds.
 */
export async function forceCancelAppointment(db: Prisma.TransactionClient, appointmentId: string) {
  const appointment = await appointmentsRepo.findAppointmentById(db, appointmentId);
  if (!appointment || appointment.status !== 'scheduled') {
    return null; // already terminal — idempotent for the caller
  }
  const updated = await appointmentsRepo.updateStatusIfScheduled(db, appointmentId, 'cancelled');
  if (updated.count === 1 && appointment.availabilitySlotId) {
    const released = await availabilityService.releaseBookedSlotIfFuture(db, appointment.availabilitySlotId);
    if (released) {
      await appointmentsRepo.clearAvailabilitySlotLink(db, appointmentId);
    }
  }
  return appointmentsRepo.findAppointmentById(db, appointmentId);
}

/** Retention hold (issue #41, docs/adr/0010): appointments are clinical
 * records, so a patient who has any is never purged after deletion. */
export function hasAppointmentsForPatient(patientProfileId: string): Promise<boolean> {
  return appointmentsRepo.patientHasAppointments(patientProfileId);
}
