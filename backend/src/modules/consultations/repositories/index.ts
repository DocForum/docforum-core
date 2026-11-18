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
    include: {
      appointment: true,
      referrals: true,
      // Issue #64: the read API returns the note plus its addenda in order.
      addenda: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
}

/**
 * Issue #64: notes are editable only while `signedAt` is null. The condition
 * is part of the UPDATE, not a read-then-write — a sign-off that commits
 * between a caller's check and this write makes the update match zero rows,
 * which the service turns into a 409. Returns the number of rows changed.
 */
export function updateNotesIfUnsigned(db: DbClient, id: string, notes: string) {
  return db.consultation.updateMany({
    where: { id, signedAt: null },
    data: { notes },
  });
}

/** Sets `signedAt` exactly once, conditionally. See updateNotesIfUnsigned. */
export function signOffIfUnsigned(db: DbClient, id: string) {
  return db.consultation.updateMany({
    where: { id, signedAt: null },
    data: { signedAt: new Date() },
  });
}

/** Consultations whose appointment completed before `cutoff` and that are
 * still unsigned — the auto sign-off sweep's work list. */
export function findDueForSignOff(db: DbClient, cutoff: Date, take: number) {
  return db.consultation.findMany({
    where: {
      signedAt: null,
      appointment: { status: 'completed', completedAt: { not: null, lte: cutoff } },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take,
  });
}

export function createAddendum(
  db: DbClient,
  data: { consultationId: string; authorDoctorId: string; body: string },
) {
  return db.consultationAddendum.create({ data });
}
