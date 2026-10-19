import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function createAppointment(
  db: DbClient,
  data: { patientProfileId: string; doctorProfileId: string; availabilitySlotId: string },
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

/** Minimal appointment context for a doctor-owned consultation. */
export function findAppointmentDoctorContext(id: string) {
  return prisma.appointment.findUnique({ where: { id }, include: { doctorProfile: { select: { id: true, userId: true, verificationStatus: true } } } });
}