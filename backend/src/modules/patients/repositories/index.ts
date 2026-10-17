import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function findPatientProfileByUserId(userId: string) {
  return prisma.patientProfile.findUnique({ where: { userId } });
}

// --- Account deletion (Phase 8, issue #41, docs/adr/0007) ----------------

/** What a deleted patient's profile shows from now on (e.g. in a doctor's
 * appointment list). */
export const ANONYMIZED_PATIENT_NAME = 'Deleted patient';

/** Anonymises the profile in place, conditional on it not already being
 * anonymised. The row (and its id) stays: appointments and payments keep
 * their foreign key to it. */
export async function anonymizeProfile(db: DbClient, profileId: string, anonymizedAt: Date): Promise<boolean> {
  const result = await db.patientProfile.updateMany({
    where: { id: profileId, anonymizedAt: null },
    data: { fullName: ANONYMIZED_PATIENT_NAME, dateOfBirth: null, guardianUserId: null, anonymizedAt },
  });
  return result.count === 1;
}

/** One keyset page of anonymised profiles old enough to be purge
 * candidates. */
export function findAnonymizedProfilesPage(anonymizedBefore: Date, cursor: string | undefined, take: number) {
  return prisma.patientProfile.findMany({
    where: { anonymizedAt: { lte: anonymizedBefore } },
    select: { id: true, userId: true },
    orderBy: { id: 'asc' },
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/** Hard-deletes an anonymised profile. Conditional on `anonymizedAt` being
 * set, so a live profile can never be removed here; and every clinical or
 * payment table references the profile with ON DELETE RESTRICT, so a row
 * that still has records makes this throw instead of cascading. */
export async function deleteAnonymizedProfile(db: DbClient, profileId: string): Promise<boolean> {
  const result = await db.patientProfile.deleteMany({ where: { id: profileId, anonymizedAt: { not: null } } });
  return result.count === 1;
}
