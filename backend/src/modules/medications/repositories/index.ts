// medications repositories — Medication (controlled vocabulary) data access
// only. Other modules (orders for prescription issuance, facilities for
// capability matching) must call ../services, never import this file
// (AGENTS.md hard rule 4).
import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export interface MedicationRow {
  id: string;
  genericName: string;
  strength: string;
  form: string;
  route: string;
  externalCode: string | null;
}

export function findById(id: string, db: DbClient = prisma) {
  return db.medication.findUnique({ where: { id } });
}

export function findByIds(ids: string[], db: DbClient = prisma) {
  if (ids.length === 0) return Promise.resolve([]);
  return db.medication.findMany({ where: { id: { in: ids } } });
}

/**
 * Trigram-backed autocomplete (issue #69).
 *
 * `ILIKE '%q%'` is servable by the GIN `gin_trgm_ops` index created in the
 * `medication_catalog` migration, and `similarity()` ranks the closest
 * generic name first. The query text is a parameter, never interpolated.
 *
 * Deliberately searches `genericName` only: that is the column the trigram
 * index covers, so the query stays index-supported as the catalog grows to
 * tens of thousands of rows (measured in tests/integration/medications).
 * Strength/form/route are returned on every hit, so a clinician still sees
 * the exact variant to pick.
 */
export function searchByGenericName(query: string, limit: number, db: DbClient = prisma): Promise<MedicationRow[]> {
  const pattern = `%${query}%`;
  return db.$queryRaw<MedicationRow[]>`
    SELECT id, "genericName", strength, form, route, "externalCode"
    FROM "Medication"
    WHERE "genericName" ILIKE ${pattern}
    ORDER BY similarity("genericName", ${query}) DESC, "genericName" ASC, strength ASC, form ASC
    LIMIT ${limit}
  `;
}

export interface UpsertMedicationInput {
  genericName: string;
  strength: string;
  form: string;
  route: string;
  externalCode: string | null;
}

/**
 * Idempotent catalog upsert for the import script (issue #69). Matching is by
 * `externalCode` when the source dataset supplies one, otherwise by the
 * natural key (generic name + strength + form + route). Re-running an import
 * updates the catalog row in place; it never touches a `PrescriptionItem`,
 * which stores its own snapshot.
 */
export function upsertMedication(input: UpsertMedicationInput) {
  if (input.externalCode) {
    return prisma.medication.upsert({
      where: { externalCode: input.externalCode },
      create: input,
      update: {
        genericName: input.genericName,
        strength: input.strength,
        form: input.form,
        route: input.route,
      },
    });
  }
  return prisma.medication.upsert({
    where: {
      genericName_strength_form_route: {
        genericName: input.genericName,
        strength: input.strength,
        form: input.form,
        route: input.route,
      },
    },
    create: input,
    update: {},
  });
}

export function countMedications() {
  return prisma.medication.count();
}
