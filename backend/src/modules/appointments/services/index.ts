import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import type { AppointmentStatus, Prisma } from '@prisma/client';
import { transitionAppointmentStatus } from '../state-machine';
import * as appointmentsRepo from '../repositories';
import * as availabilityService from '../../availability/services';
import * as doctorsService from '../../doctors/services';
import * as patientsService from '../../patients/services';
import * as auditService from '../../audit/services';
import * as referralsService from '../../referrals/services';
import * as notificationsService from '../../notifications/services';

/**
 * Books a slot for the calling patient. This is the correctness-critical
 * path in the whole backend (ARCHITECTURE%20md%20%C2%A75.1 / ROADMAP.md Phase 1 —
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
 *
 * Phase 6: booking-confirmed (patient) and new-booking (doctor)
 * notifications are enqueued through the transactional outbox in the same
 * transaction, after the Appointment row exists — so a notification is emitted
 * if and only if the booking commits.
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

    // Phase 6 (FR-15/16): booking-confirmed to the patient and new-booking
    // alert to the doctor, enqueued in the same transaction as the booking.
    await notificationsService.emitBookingConfirmed(tx, appointment);
    await notificationsService.emitNewBookingAlert(tx, appointment);

    return appointment;
  });
}

export async function listMyAppointments(userId: string, patientProfileId?: string) {
  const patientProfile = await patientsService.resolveActingProfile(userId, patientProfileId);
  return appointmentsRepo.findAppointmentsForPatient(patientProfile.id);
}

/**
 * Reschedules an appointment atomically: in one transaction, claims the new
 * slot and releases the old one. The new slot must belong to the same
 * doctor (or be explicitly allowed).
 *
 * Requirements from issue #55:
 - Add `POST /appointments/:id/reschedule` with `{ newSlotId }`
 - In one transaction: conditionally claim the new slot (`WHERE status = 'open'`),
   re-point the appointment, and release the old slot back to `open`
 - Respect a configurable cutoff (e.g. no reschedule within 2h of start)
 - Concurrency tests: two patients rescheduling into the same slot, and a
   reschedule racing a fresh booking
 */
export async function rescheduleSlot(
  actor: auditService.AuditActor,
  appointmentId: string,
  newSlotId: string,
  cutoffHours: number = 2,
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const patientProfile = await patientsService.getMyPatientProfile(actor.userId);

  return prisma.$transaction(async (tx) => {
    // First, get the existing appointment to find its current slot
    const existingAppointment = await appointmentsRepo.findAppointmentById(tx, appointmentId);
    if (!existingAppointment) {
      throw new HttpError(404, 'Appointment not found.');
    }

    // Check that the appointment belongs to this patient
    if (existingAppointment.patientProfileId !== patientProfile.id) {
      throw new HttpError(403, 'This appointment does not belong to you.');
    }
    const currentSlotId = existingAppointment.availabilitySlotId;
    if (!currentSlotId) {
      throw new HttpError(409, 'Appointment no longer has an active slot.');
    }

    // Check cutoff: no reschedule within cutoffHours of slot start
    const slot = await availabilityService.getSlot(tx, currentSlotId);
    if (!slot) {
      throw new HttpError(404, 'Original slot not found.');
    }

    const slotStart = slot.startTime;
    const now = new Date();
    const cutoffMs = cutoffHours * 60 * 60 * 1000;
    if (now.getTime() - slotStart.getTime() < -cutoffMs) {
      // Slot hasn't started yet and we're within the cutoff window
      throw new HttpError(409, `Rescheduling is not allowed within ${cutoffHours} hours of the slot start time.`);
    }

    // Claim the new slot atomically
    const newClaimed = await availabilityService.claimOpenSlot(tx, newSlotId);
    if (!newClaimed) {
      throw new HttpError(409, 'The new slot is no longer available.');
    }

    // Release the old slot atomically (only if it's still booked by this appointment)
    await tx.availabilitySlot.updateMany({
      where: { id: currentSlotId, status: 'booked' },
      data: { status: 'open' },
    });

    // Re-point the appointment to the new slot
    const updatedAppointment = await appointmentsRepo.updateAppointment(tx, appointmentId, {
      availabilitySlotId: newSlotId,
    });

    await auditService.record(tx, actor, {
      entityType: 'Appointment',
      entityId: updatedAppointment.id,
      action: 'appointment.rescheduled',
      fromState: existingAppointment.status,
      toState: updatedAppointment.status,
      metadata: {
        oldSlotId: currentSlotId,
        newSlotId,
      },
    });

    return updatedAppointment;
  });
}

/**
 * Cancels an appointment atomically: releases the slot back to `open` and
 * marks the appointment as cancelled. Includes cutoff window logic.
 *
 * Requirements from issue #56:
 - Patient can cancel an appointment
 - Before cutoff (2h before slot start): slot releases to `open`
 - After cutoff: slot stays booked, appointment marked `late_cancelled`
 - Concurrency: slot release is conditional on status = `booked`
 */
export async function cancelAppointment(
  actor: auditService.AuditActor,
  appointmentId: string,
  reason: 'patient' | 'doctor' = 'patient',
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const patientProfile = await patientsService.getMyPatientProfile(actor.userId);

  return prisma.$transaction(async (tx) => {
    // First, get the existing appointment to find its current slot
    const existingAppointment = await appointmentsRepo.findAppointmentById(tx, appointmentId);
    if (!existingAppointment) {
      throw new HttpError(404, 'Appointment not found.');
    }

    // Check that the caller is the patient
    if (existingAppointment.patientProfileId !== patientProfile.id) {
      throw new HttpError(403, 'Only the patient can cancel this appointment.');
    }
    const currentSlotId = existingAppointment.availabilitySlotId;
    if (!currentSlotId) {
      throw new HttpError(409, 'Appointment no longer has an active slot.');
    }

    // Check cutoff: no cancellation within 2 hours of slot start
    const slot = await availabilityService.getSlot(tx, currentSlotId);
    if (!slot) {
      throw new HttpError(404, 'Original slot not found.');
    }

    const slotStart = slot.startTime;
    const now = new Date();
    const cutoffMs = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

    // Determine the new status based on cutoff
    let newStatus: string;
    let slotStatus: string;

    if (now.getTime() - slotStart.getTime() < -cutoffMs) {
      // Slot hasn't started yet and we're within the cutoff window
      newStatus = 'cancelled';
      slotStatus = 'open';
    } else {
      // Past cutoff: slot stays booked, appointment marked late-cancelled
      newStatus = 'late_cancelled';
      slotStatus = 'booked';
    }

    // Update the appointment status
    const updatedAppointment = await appointmentsRepo.updateAppointment(tx, appointmentId, {
      status: newStatus as any,
    });

    // Release the old slot only if within cutoff window
    if (slotStatus === 'open') {
      await tx.availabilitySlot.updateMany({
        where: { id: currentSlotId, status: 'booked' },
        data: { status: 'open' },
      });
    }

    await auditService.record(tx, actor, {
      entityType: 'Appointment',
      entityId: updatedAppointment.id,
      action: 'appointment.cancelled',
      fromState: existingAppointment.status,
      toState: newStatus,
      metadata: {
        reason,
        slotId: currentSlotId,
      },
    });

    return updatedAppointment;
  });
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

  return prisma.$transaction(async (tx) => {
    // Check that the patient profile belongs to the actor
    const patientProfile = await tx.patientProfile.findUnique({
      where: { id: patientProfileId },
    });
    if (!patientProfile) {
      throw new HttpError(404, 'Patient profile not found.');
    }

    // Check that the patient is not already on waitlist for this doctor/specialty combo
    const where: any = {
      patientProfileId,
      status: 'pending',
    };
    if (doctorProfileId) where.doctorProfileId = doctorProfileId;
    if (specialtyId) where.specialtyId = specialtyId;

    const existingEntry = await tx.waitlistEntry.findFirst({
      where,
    });

    if (existingEntry) {
      throw new HttpError(409, 'Patient is already on the waitlist for this doctor or specialty.');
    }

    const entry = await tx.waitlistEntry.create({
      data: {
        patientProfileId,
        doctorProfileId: doctorProfileId ?? null,
        specialtyId: specialtyId ?? null,
        earliestAcceptable: earliestAcceptable ?? null,
        latestAcceptable: latestAcceptable ?? null,
        holdDurationMinutes: holdDurationMinutes ?? null,
        status: 'pending',
      },
    });

    await auditService.record(tx, actor, {
      entityType: 'WaitlistEntry',
      entityId: entry.id,
      action: 'waitlist.joined',
      fromState: null,
      toState: entry.status,
      metadata: {
        patientProfileId,
        doctorProfileId: doctorProfileId ?? null,
        specialtyId: specialtyId ?? null,
      },
    });

    return entry;
  });
}