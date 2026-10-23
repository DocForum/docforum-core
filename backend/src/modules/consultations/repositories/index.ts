// consultations repositories — data access only. Not to be imported by
// other modules directly — go through services/ instead (AGENTS.md).
//
// Every write that could touch a signed-off note is scoped with
// `signedAt: null` in the WHERE clause: the update either matches a draft
// (count === 1) or it matches nothing. That's the repository half of the
// immutability rule; the DB trigger added in the migration is the half that
// holds even for callers who skip this file.
import { prisma } from '../../../db/prisma-client';
import type { Consultation, ConsultationOutcome, Prisma } from '@prisma/client';

export function createConsultation(data: {
  appointmentId: string;
  doctorProfileId: string;
  notes?: string;
  outcome?: ConsultationOutcome;
}) {
  return prisma.consultation.create({ data });
}

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
