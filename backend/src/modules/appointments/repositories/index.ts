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

/** One keyset page of a patient's appointments, oldest first (patient data
 * export, issue #40). Appointment columns only — slot/doctor details come
 * from those modules' services, not a join. */
export function findAppointmentsPageForPatient(patientProfileId: string, cursor: string | undefined, take: number) {
  return prisma.appointment.findMany({
    where: { patientProfileId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

export function findAppointmentsForPatient(patientProfileId: string) {
  return prisma.appointment.findMany({
    where: { patientProfileId },
    include: { availabilitySlot: true },
    orderBy: { createdAt: 'desc' },
  });
}

/** Today's scheduled appointments for one doctor's own calendar. The
 * caller supplies the server-local day bounds; no patient-module data is
 * joined here, preserving the module boundary. */
export function findAppointmentsForDoctorOnDay(doctorProfileId: string, start: Date, end: Date) {
  return prisma.appointment.findMany({
    where: {
      doctorProfileId,
      status: 'scheduled',
      availabilitySlot: { is: { startTime: { gte: start, lt: end } } },
    },
    include: { availabilitySlot: true },
    orderBy: [{ availabilitySlot: { startTime: 'asc' } }, { id: 'asc' }],
  });
}

/** Minimal appointment context for a doctor-owned consultation. */
export function findAppointmentDoctorContext(id: string) {
  return prisma.appointment.findUnique({ where: { id }, include: { doctorProfile: { select: { id: true, userId: true, verificationStatus: true } } } });
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

/** Existence check for the account-deletion retention hold (issue #41). */
export async function patientHasAppointments(patientProfileId: string): Promise<boolean> {
  return (await prisma.appointment.findFirst({ where: { patientProfileId }, select: { id: true } })) !== null;
}
