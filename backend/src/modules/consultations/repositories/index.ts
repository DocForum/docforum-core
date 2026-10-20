import { prisma } from '../../../db/prisma-client';
import type { ConsultationOutcome, Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function createConsultation(
  db: DbClient,
  data: { appointmentId: string; outcome?: ConsultationOutcome; notes?: string },
) {
  return db.consultation.create({ data });
}

export function findConsultationById(db: DbClient, id: string) {
  return db.consultation.findUnique({
    where: { id },
    include: { appointment: true, referrals: true },
  });
}

export function findConsultationByAppointmentId(db: DbClient, appointmentId: string) {
  return db.consultation.findUnique({ where: { appointmentId } });
}
