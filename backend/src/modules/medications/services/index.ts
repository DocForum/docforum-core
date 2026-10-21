// medications services — other modules must import from here, never
// from repositories/ directly (AGENTS.md module-boundary rule).
import { prisma } from '../../../db/prisma-client';
import * as medicationsRepo from '../repositories';
import { HttpError } from '../../../http-error';

export interface MedicationView {
  id: string;
  genericName: string;
  strength: string | null;
  form: string | null;
  route: string | null;
  externalCode: string | null;
  externalSystem: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MedicationAutocompleteResult {
  id: string;
  genericName: string;
  strength: string | null;
  form: string | null;
  route: string | null;
  displayName: string; // e.g., "Paracetamol 500mg tablet (oral)"
}

function toAutocompleteResult(med: { id: string; genericName: string; strength: string | null; form: string | null; route: string | null; externalCode: string | null }): MedicationAutocompleteResult {
  const parts = [med.genericName];
  if (med.strength) parts.push(med.strength);
  if (med.form) parts.push(med.form);
  if (med.route) parts.push(`(${med.route})`);
  return {
    id: med.id,
    genericName: med.genericName,
    strength: med.strength,
    form: med.form,
    route: med.route,
    displayName: parts.join(' '),
  };
}

export async function getMedicationAutocomplete(
  query: string,
  limit: number = 20,
): Promise<MedicationAutocompleteResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return []; // Require at least 2 characters

  const medications = await medicationsRepo.searchMedications(trimmed, limit);
  return medications.map(toAutocompleteResult);
}

export async function listMedicationsPaginated(
  cursor: string | undefined,
  pageSize: number,
): Promise<{ items: MedicationView[]; nextCursor: string | null }> {
  const items = await medicationsRepo.listMedications(cursor, pageSize);
  const nextCursor = items.length === pageSize ? items[items.length - 1].id : null;
  return { items, nextCursor };
}

export async function createMedicationRecord(
  input: {
    genericName: string;
    strength?: string;
    form?: string;
    route?: string;
    externalCode?: string;
    externalSystem?: string;
  },
) {
  const { genericName, ...rest } = input;
  if (!genericName.trim()) {
    throw new HttpError(400, 'genericName is required.');
  }
  if (genericName.length > 200) {
    throw new HttpError(400, 'genericName must be at most 200 characters.');
  }
  if (rest.externalCode && rest.externalCode.length > 100) {
    throw new HttpError(400, 'externalCode must be at most 100 characters.');
  }

  try {
    return await medicationsRepo.upsertMedication(prisma, input);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'A medication with this external code already exists.');
    }
    throw error;
  }
}

export async function getMedicationById(id: string): Promise<MedicationView | null> {
  const med = await medicationsRepo.findMedicationById(id);
  if (!med) return null;
  return {
    id: med.id,
    genericName: med.genericName,
    strength: med.strength,
    form: med.form,
    route: med.route,
    externalCode: med.externalCode,
    externalSystem: med.externalSystem,
    createdAt: med.createdAt,
    updatedAt: med.updatedAt,
  };
}

export async function getMedicationsByIds(ids: string[]): Promise<MedicationView[]> {
  const medications = await medicationsRepo.findMedicationsByIds(ids);
  return medications.map((med) => ({
    id: med.id,
    genericName: med.genericName,
    strength: med.strength,
    form: med.form,
    route: med.route,
    externalCode: med.externalCode,
    externalSystem: med.externalSystem,
    createdAt: med.createdAt,
    updatedAt: med.updatedAt,
  }));
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}