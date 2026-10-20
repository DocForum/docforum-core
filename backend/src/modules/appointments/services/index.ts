import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import type { AppointmentStatus, Prisma } from '@prisma/client';
import * as appointmentsRepo from '../repositories';
import * as availabilityService from '../../availability/services';
import * as doctorsService from '../../doctors/services';
import * as patientsService from '../../patients/services';
import * as auditService from '../../audit/services';
import * as referralsService from '../../referrals/services';

/**
 * Books a slot for the calling patient. This is the correctness-critical
 * path in the whole backend (ARCHITECTURE.md §5.1 / ROADMAP.md Phase 1 —
 * "the single highest-priority correctness item in the whole roadmap").
 *
 * Two steps, one transaction:
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
 * Phase 8, issue #43: the booking's AuditEvent is written as a third step
 * of the same transaction, after the Appointment row exists — so an event
 * exists if and only if the booking committed. A caller that loses the
 * race fails at step 1 and never reaches it.
 */
export async function bookSlot(actor: auditService.AuditActor, availabilitySlotId: string) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const patientProfile = await patientsService.getMyPatientProfile(actor.userId);

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
      metadata: { availabilitySlotId, doctorProfileId: slot.doctorProfileId, origin: appointment.origin },
    });

    return appointment;
  });
}

export async function listMyAppointments(userId: string) {
  const patientProfile = await patientsService.getMyPatientProfile(userId);
  return appointmentsRepo.findAppointmentsForPatient(patientProfile.id);
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
  const claimed = await availabilityService.claimOpenSlot(db, input.availabilitySlotId);
  if (!claimed) {
    throw new HttpError(409, 'This slot is no longer available.');
  }

  const slot = await availabilityService.getSlot(db, input.availabilitySlotId);
  if (!slot) {
    throw new HttpError(404, 'Slot not found.');
  }
  if (slot.doctorProfileId !== input.doctorProfileId) {
    throw new HttpError(409, 'That slot does not belong to the referral’s target doctor.');
  }

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
      status: newStatus as 'completed' | 'cancelled' | 'no_show',
    });
  }
}

/**
 * Doctor-side lifecycle transition (issue #3): the treating doctor marks
 * their own appointment completed / cancelled / no_show. Restricted to
 * the doctor the appointment is against — no admin-on-behalf path in v1.
 */
export async function updateStatusByDoctor(userId: string, appointmentId: string, newStatus: AppointmentStatus) {
  const appointment = await appointmentsRepo.findAppointmentById(prisma, appointmentId);
  if (!appointment) throw new HttpError(404, 'Appointment not found.');
  await doctorsService.assertOwnsDoctorProfile(userId, appointment.doctorProfileId);
  if (appointment.status !== 'scheduled') {
    throw new HttpError(409, 'Only a scheduled appointment can change status.');
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
export async function cancelByPatient(userId: string, appointmentId: string) {
  const patientProfile = await patientsService.getMyPatientProfile(userId);
  const appointment = await appointmentsRepo.findAppointmentById(prisma, appointmentId);
  if (!appointment) throw new HttpError(404, 'Appointment not found.');
  if (appointment.patientProfileId !== patientProfile.id) {
    throw new HttpError(403, 'You can only cancel your own appointments.');
  }
  if (appointment.status !== 'scheduled') {
    throw new HttpError(409, 'Only a scheduled appointment can be cancelled.');
  }

  return prisma.$transaction(async (tx) => {
    await applyScheduledTransition(tx, appointment, 'cancelled');
    return appointmentsRepo.findAppointmentById(tx, appointmentId);
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
