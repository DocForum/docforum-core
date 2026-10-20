// consultations repositories — data access only. Not to be imported by
// other modules directly — go through services/ instead (AGENTS.md).
//
// Every write that could touch a signed-off note is scoped with
// `signedAt: null` in the WHERE clause: the update either matches a draft
// (count === 1) or it matches nothing. That's the repository half of the
// immutability rule; the DB trigger added in the migration is the half that
// holds even for callers who skip this file.
import { prisma } from '../../../db/prisma-client';
import type { ConsultationOutcome } from '@prisma/client';

export function createConsultation(data: {
  appointmentId: string;
  doctorProfileId: string;
  notes?: string;
  outcome?: ConsultationOutcome;
}) {
  return prisma.consultation.create({ data });
}

export function findConsultationById(id: string) {
  return prisma.consultation.findUnique({
    where: { id },
    include: { addenda: { orderBy: { createdAt: 'asc' } } },
  });
}

/** Only matches while the consultation is unsigned. Returns the update
 * count so the service can distinguish "written" from "signed off". */
export function updateConsultationDraft(
  id: string,
  data: { notes?: string; outcome?: ConsultationOutcome },
) {
  return prisma.consultation.updateMany({
    where: { id, signedAt: null },
    data,
  });
}

/** Only matches while unsigned — a second sign-off is a 0-row update, not
 * a race that could overwrite the original timestamp. */
export function signOffConsultation(id: string, signedAt: Date) {
  return prisma.consultation.updateMany({
    where: { id, signedAt: null },
    data: { signedAt },
  });
}

export function createAddendum(data: { consultationId: string; authorDoctorProfileId: string; body: string }) {
  return prisma.consultationAddendum.create({ data });
}

export function findAddenda(consultationId: string) {
  return prisma.consultationAddendum.findMany({
    where: { consultationId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Drafts whose edit window has elapsed. `now - autoSignoffHours` is the
 * cutoff: anything created before it is signed off automatically so notes
 * don't stay editable forever (issue #64).
 */
export function findConsultationsDueForAutoSignOff(cutoff: Date) {
  return prisma.consultation.findMany({
    where: { signedAt: null, createdAt: { lte: cutoff } },
    select: { id: true },
  });
}
