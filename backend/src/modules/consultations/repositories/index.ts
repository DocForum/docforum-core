import { prisma } from '../../../db/prisma-client';
import type { Consultation, ConsultationOutcome, Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function findConsultationByAppointmentId(
  appointmentId: string,
  db: DbClient = prisma,
): Promise<Consultation | null> {
  return db.consultation.findUnique({ where: { appointmentId } });
}

export function createConsultation(
  db: DbClient,
  data: { appointmentId: string; outcome: ConsultationOutcome; notes: string },
): Promise<Consultation> {
  return db.consultation.create({ data });
}
