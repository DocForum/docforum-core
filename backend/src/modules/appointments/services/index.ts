import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import * as appointmentsRepo from '../repositories';
import * as availabilityService from '../../availability/services';
import * as patientsService from '../../patients/services';
import * as doctorsService from '../../doctors/services';
import * as auditService from '../../audit/services';

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

/**
 * Cross-module entry point for the consultations module: return the
 * appointment a doctor may act on, or null if the appointment doesn't exist
 * or isn't theirs. The consultations module never queries `Appointment`
 * directly — it calls this service instead (AGENTS.md hard rule 4).
 */
export async function getAppointmentForDoctor(doctorUserId: string, appointmentId: string) {
  const appointment = await appointmentsRepo.findAppointmentById(appointmentId);
  if (!appointment) return null;

  const doctorProfile = await doctorsService.getDoctorProfileById(appointment.doctorProfileId);
  if (doctorProfile.userId !== doctorUserId) return null;

  return appointment;
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
        const [slots, doctors] = await Promise.all([
          availabilityService.getSlotTimesByIds(rows.map((row) => row.availabilitySlotId)),
          doctorsService.getDoctorSummariesByIds(rows.map((row) => row.doctorProfileId)),
        ]);
        return rows.map((row) => ({
          id: row.id,
          status: row.status,
          origin: row.origin,
          slot: slots.get(row.availabilitySlotId) ?? null,
          doctor: doctors.get(row.doctorProfileId) ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }));
      },
    );
  },
};
