import { prisma } from '../../../db/prisma-client';
import type { AppointmentStatus, Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function createAppointment(
  db: DbClient,
  data: {
    patientProfileId: string;
    doctorProfileId: string;
    availabilitySlotId: string;
    origin?: 'direct_booking' | 'referral';
    referralId?: string;
  },
) {
  return db.appointment.create({ data });
}

export function findAppointmentsForPatient(patientProfileId: string) {
  return prisma.appointment.findMany({
    where: { patientProfileId },
    include: { availabilitySlot: true },
    orderBy: { createdAt: 'desc' },
  });
}

export function findAppointmentById(db: DbClient, id: string) {
  return db.appointment.findUnique({ where: { id } });
}

/**
 * The appointment state machine's only write path: a conditional UPDATE
 * that matches `status = 'scheduled'`. Exactly one concurrent caller can
 * move a given appointment out of `scheduled`; a second attempt (or a
 * replayed hook) matches zero rows, which the service turns into a 409 —
 * this is what makes the referral cascade (issue #67) at-most-once per
 * real transition, without relying on app-level checks.
 */
export function updateStatusIfScheduled(db: DbClient, id: string, status: AppointmentStatus) {
  return db.appointment.updateMany({ where: { id, status: 'scheduled' }, data: { status } });
}

/**
 * A cancelled appointment that released its slot back to `open` must also
 * drop its unique claim on availabilitySlotId — otherwise re-booking the
 * freed slot hits the unique constraint (discovered by the cascade
 * integration tests). The history row survives; only the slot link is
 * cleared.
 */
export function clearAvailabilitySlotLink(db: DbClient, id: string) {
  return db.appointment.updateMany({ where: { id }, data: { availabilitySlotId: null } });
}
