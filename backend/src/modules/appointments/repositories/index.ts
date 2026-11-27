import { prisma } from '../../../db/prisma-client';
import type { AppointmentStatus, Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function createAppointment(
  db: DbClient,
  data: {
    patientProfileId: string;
    doctorProfileId: string;
    availabilitySlotId: string;
    calendarStartTime: Date;
    calendarEndTime: Date;
    origin?: 'direct_booking' | 'referral' | 'follow_up';
    referralId?: string;
  },
) {
  return db.appointment.create({ data });
}

/** Find a single appointment by ID (used inside transactions). */
export function findAppointmentById(db: DbClient, id: string) {
  return db.appointment.findUnique({ where: { id } });
}

/** Update an appointment (used inside transactions). */
export async function updateAppointment(
  db: DbClient,
  id: string,
  data: { availabilitySlotId?: string; status?: AppointmentStatus },
) {
  return db.appointment.update({ where: { id }, data });
}

/** Update an appointment's availabilitySlotId (used inside transactions). */
export async function updateAvailabilitySlotId(
  db: DbClient,
  id: string,
  data: { availabilitySlotId: string },
) {
  return db.appointment.update({ where: { id }, data });
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

export function findAppointmentsForDoctor(doctorProfileId: string) {
  return prisma.appointment.findMany({
    where: { doctorProfileId },
    include: { availabilitySlot: true },
    orderBy: { createdAt: 'desc' },
  });
}

/** Today's scheduled appointments for one doctor's own calendar. The
 * caller supplies the doctor's local calendar day bounds; no patient-module data is
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

/** Only calendar-safe fields are selected; patient identity and clinical
 * records never enter the feed projection. */
export function findAppointmentsForCalendarFeed(doctorProfileId: string, db: DbClient = prisma) {
  return db.appointment.findMany({
    where: {
      doctorProfileId,
      OR: [
        { calendarStartTime: { not: null }, calendarEndTime: { not: null } },
        { availabilitySlotId: { not: null } },
      ],
    },
    select: {
      id: true,
      status: true,
      calendarStartTime: true,
      calendarEndTime: true,
      updatedAt: true,
      availabilitySlot: { select: { startTime: true, endTime: true } },
    },
    orderBy: [{ calendarStartTime: 'asc' }, { id: 'asc' }],
  });
}

/** Appointments across an arbitrary date range in the doctor's calendar (issue #291). */
export function findAppointmentsForDoctorSchedule(
  doctorProfileId: string,
  start: Date,
  end: Date,
  status?: AppointmentStatus,
) {
  return prisma.appointment.findMany({
    where: {
      doctorProfileId,
      ...(status ? { status } : {}),
      OR: [
        { availabilitySlot: { is: { startTime: { gte: start, lt: end } } } },
        { availabilitySlotId: null, updatedAt: { gte: start, lt: end } },
      ],
    },
    include: { availabilitySlot: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/** Minimal appointment context for a doctor-owned consultation. */
export function findAppointmentDoctorContext(id: string) {
  return prisma.appointment.findUnique({ where: { id }, include: { doctorProfile: { select: { id: true, userId: true, verificationStatus: true } } } });
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
 * Conditionally repoints an appointment's availabilitySlotId if it is still scheduled.
 */
export function rescheduleIfScheduled(
  db: DbClient,
  id: string,
  newSlotId: string,
  calendarStartTime: Date,
  calendarEndTime: Date,
) {
  return db.appointment.updateMany({
    where: { id, status: 'scheduled' },
    data: { availabilitySlotId: newSlotId, calendarStartTime, calendarEndTime },
  });
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

/** One keyset page of a patient's waitlist entries (issue #336). Waitlist
 * columns only — doctor/specialty details come from those modules' services,
 * not a join. */
export function findWaitlistEntriesPageForPatient(patientProfileId: string, cursor: string | undefined, take: number) {
  return prisma.waitlistEntry.findMany({
    where: { patientProfileId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}
