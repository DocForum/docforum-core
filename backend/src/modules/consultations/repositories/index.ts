import { prisma } from '../../../db/prisma-client';
import type { Consultation, ConsultationOutcome, Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function createConsultation(
  db: DbClient,
  data: { appointmentId: string; outcome: ConsultationOutcome | null; notes: string | null },
): Promise<Consultation> {
  return db.consultation.create({ data });
}

/** One consultation per appointment (the unique index is the guarantee —
 * this read is only for callers that need the row without a write). */
export function findConsultationByAppointmentId(
  db: DbClient,
  appointmentId: string,
): Promise<Consultation | null> {
  return db.consultation.findUnique({ where: { appointmentId } });
}

export function findConsultationById(db: DbClient, id: string) {
  return db.consultation.findUnique({
    where: { id },
    include: { appointment: true, referrals: true },
  });
}

/**
 * Conditional update that closes an open consultation only if outcome IS NULL.
 * Returns the updated row or null if already closed.
 */
export async function closeOpenConsultation(
  db: DbClient,
  where: { appointmentId: string },
  data: { outcome: ConsultationOutcome; notes?: string | null },
): Promise<Consultation | null> {
  let count: number;
  if (data.notes !== undefined) {
    count = await db.$executeRaw`
      UPDATE "Consultation"
      SET "outcome" = ${data.outcome}::"ConsultationOutcome",
          "notes" = ${data.notes},
          "updatedAt" = NOW()
      WHERE "appointmentId" = ${where.appointmentId}
        AND "outcome" IS NULL
    `;
  } else {
    count = await db.$executeRaw`
      UPDATE "Consultation"
      SET "outcome" = ${data.outcome}::"ConsultationOutcome",
          "updatedAt" = NOW()
      WHERE "appointmentId" = ${where.appointmentId}
        AND "outcome" IS NULL
    `;
  }
  if (count === 0) {
    return null;
  }
  return db.consultation.findUnique({ where: { appointmentId: where.appointmentId } });
}
