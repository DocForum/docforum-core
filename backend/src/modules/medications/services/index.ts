// medications services — the only surface other modules may use to read the
// controlled medication vocabulary (AGENTS.md hard rule 4).
import { HttpError } from '../../../http-error';
import * as medicationsRepo from '../repositories';
import type { Prisma } from '@prisma/client';

export interface MedicationSearchResult {
  id: string;
  /** What a prescription item snapshots as its display name. */
  displayName: string;
  genericName: string;
  strength: string;
  form: string;
  route: string;
  externalCode: string | null;
}

/**
 * The display name stored on a `PrescriptionItem` when the item is issued
 * from the catalog: generic name + strength + form, so a pharmacy reads one
 * unambiguous line. It is a snapshot taken at issuance — later catalog edits
 * do not rewrite it (hard rule 1 applies to the whole prescription).
 */
export function displayName(medication: {
  genericName: string;
  strength: string;
  form: string;
}): string {
  return [medication.genericName, medication.strength, medication.form]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ');
}

function toSearchResult(medication: medicationsRepo.MedicationRow): MedicationSearchResult {
  return {
    id: medication.id,
    displayName: displayName(medication),
    genericName: medication.genericName,
    strength: medication.strength,
    form: medication.form,
    route: medication.route,
    externalCode: medication.externalCode,
  };
}

/** Autocomplete for `GET /medications?q=` (issue #69). */
export async function searchMedications(input: { q: string; limit: number }): Promise<MedicationSearchResult[]> {
  const query = input.q.trim();
  // The trigram index needs at least a couple of characters to be selective;
  // a single-letter query is a full scan dressed up as a feature.
  if (query.length < 2) {
    throw new HttpError(400, 'q must be at least 2 characters.', 'MEDICATION_QUERY_TOO_SHORT');
  }
  const rows = await medicationsRepo.searchByGenericName(query, input.limit);
  return rows.map(toSearchResult);
}

/**
 * Resolves the catalog rows referenced by a prescription's items, inside the
 * issuance transaction. Used by the orders module when it writes the
 * append-only `Prescription` row, so validation and snapshotting happen in
 * the same transaction as the write.
 *
 * Throws 400 for an unknown id: a prescription must never reference a
 * medication that doesn't exist, and the FK alone would surface as a 500.
 */
export async function getMedicationsByIds(
  db: Prisma.TransactionClient,
  ids: string[],
): Promise<Map<string, medicationsRepo.MedicationRow>> {
  const uniqueIds = [...new Set(ids)];
  const rows = await medicationsRepo.findByIds(uniqueIds, db);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = uniqueIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new HttpError(
      400,
      `Unknown medicationId(s): ${missing.join(', ')}. Pick a medication from GET /medications or use the unlisted-medication path.`,
      'UNKNOWN_MEDICATION',
    );
  }
  return byId;
}
