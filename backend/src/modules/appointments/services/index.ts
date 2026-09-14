import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import * as appointmentsRepo from '../repositories';
import * as availabilityService from '../../availability/services';
import * as patientsService from '../../patients/services';

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
 */
export async function bookSlot(userId: string, availabilitySlotId: string) {
  const patientProfile = await patientsService.getMyPatientProfile(userId);

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

    return appointmentsRepo.createAppointment(tx, {
      patientProfileId: patientProfile.id,
      doctorProfileId: slot.doctorProfileId,
      availabilitySlotId,
    });
  });
}

export async function listMyAppointments(userId: string) {
  const patientProfile = await patientsService.getMyPatientProfile(userId);
  return appointmentsRepo.findAppointmentsForPatient(patientProfile.id);
}
