// lab-tests services — other modules must import from here, never
// from repositories/ directly (AGENTS.md module-boundary rule).
import { prisma } from '../../../db/prisma-client';
import * as labTestsRepo from '../repositories';
import { HttpError } from '../../../http-error';

export interface LabTestView {
  id: string;
  code: string;
  name: string;
  specimenType: string | null;
  category: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LabTestAutocompleteResult {
  id: string;
  code: string;
  name: string;
  specimenType: string | null;
  category: string | null;
  displayName: string; // e.g., "CBC (Complete Blood Count) [blood] - hematology"
}

function toAutocompleteResult(test: { id: string; code: string; name: string; specimenType: string | null; category: string | null }): LabTestAutocompleteResult {
  const parts = [test.name];
  if (test.code) parts.unshift(test.code);
  if (test.specimenType) parts.push(`[${test.specimenType}]`);
  if (test.category) parts.push(`- ${test.category}`);
  return {
    id: test.id,
    code: test.code,
    name: test.name,
    specimenType: test.specimenType,
    category: test.category,
    displayName: parts.join(' '),
  };
}

export async function getLabTestAutocomplete(
  query: string,
  limit: number = 20,
): Promise<LabTestAutocompleteResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return []; // Require at least 2 characters

  const tests = await labTestsRepo.searchLabTests(trimmed, limit);
  return tests.map(toAutocompleteResult);
}

export async function listLabTestsPaginated(
  cursor: string | undefined,
  pageSize: number,
): Promise<{ items: LabTestView[]; nextCursor: string | null }> {
  const items = await labTestsRepo.listLabTests(cursor, pageSize);
  const nextCursor = items.length === pageSize ? items[items.length - 1].id : null;
  return { items, nextCursor };
}

export async function createLabTestRecord(
  input: {
    code: string;
    name: string;
    specimenType?: string;
    category?: string;
    panelOfIds?: string[];
  },
) {
  const { code, name, ...rest } = input;
  if (!code.trim() || !name.trim()) {
    throw new HttpError(400, 'code and name are required.');
  }
  if (code.length > 50) {
    throw new HttpError(400, 'code must be at most 50 characters.');
  }
  if (name.length > 200) {
    throw new HttpError(400, 'name must be at most 200 characters.');
  }

  try {
    return await labTestsRepo.upsertLabTest(prisma, { code, name, ...rest });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'A lab test with this code already exists.');
    }
    throw error;
  }
}

export async function getLabTestById(id: string): Promise<LabTestView | null> {
  const test = await labTestsRepo.findLabTestById(id);
  if (!test) return null;
  return {
    id: test.id,
    code: test.code,
    name: test.name,
    specimenType: test.specimenType,
    category: test.category,
    createdAt: test.createdAt,
    updatedAt: test.updatedAt,
  };
}

export async function getLabTestsByIds(ids: string[]): Promise<LabTestView[]> {
  const tests = await labTestsRepo.findLabTestsByIds(ids);
  return tests.map((test) => ({
    id: test.id,
    code: test.code,
    name: test.name,
    specimenType: test.specimenType,
    category: test.category,
    createdAt: test.createdAt,
    updatedAt: test.updatedAt,
  }));
}

export async function getLabTestsByCodes(codes: string[]): Promise<LabTestView[]> {
  const tests = await labTestsRepo.findLabTestsByCodes(codes);
  return tests.map((test) => ({
    id: test.id,
    code: test.code,
    name: test.name,
    specimenType: test.specimenType,
    category: test.category,
    createdAt: test.createdAt,
    updatedAt: test.updatedAt,
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