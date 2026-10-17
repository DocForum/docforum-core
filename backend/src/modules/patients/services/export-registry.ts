// Patient data export registry (Phase 8, issue #40 — right of access).
//
// The patients module coordinates an export, but it owns none of the data
// beyond the profile itself. Every other module contributes its own section
// through its own services/ interface: it decides what the patient is
// entitled to see, pages it out of its own tables, and maps it to plain
// JSON. The patients module never queries another module's tables to build
// an export (ARCHITECTURE_ESSENTIALS.md hard rule 4).
//
// Adding a section for a new module (referrals, prescriptions, ...):
//   1. export a `PatientExportSection` from that module's services/;
//   2. add it to the list in src/export-sections.ts.
// See ARCHITECTURE.md §3 "Patient data export registry".

/** Who an export is about. `userId` is the login that owns the profile. */
export interface ExportSubject {
  patientProfileId: string;
  userId: string;
}

export interface PatientExportSection {
  /** Stable key in the bundle's `sections` object. Lowercase, no spaces. */
  name: string;
  /** Bumped by the owning module whenever its item shape changes. */
  version: number;
  /**
   * Yields the subject's records as pages of plain, JSON-safe objects (no
   * BigInt, no Prisma rows spread wholesale — an explicit allowlist of
   * fields, so a column added later can't leak into exports by default).
   * Must page: a page holds at most `pageSize` items, and the next page is
   * only fetched once the previous one has been written out.
   */
  pages(subject: ExportSubject, pageSize: number): AsyncIterable<readonly unknown[]>;
}

const SECTION_NAME = /^[a-z][a-z0-9_]*$/;
const sections = new Map<string, PatientExportSection>();

/** Registering the same section object twice is a no-op (createApp may run
 * more than once in a process); two different sections claiming one name
 * is a wiring bug and fails loudly. */
export function registerExportSection(section: PatientExportSection): void {
  if (!SECTION_NAME.test(section.name)) {
    throw new Error(`Invalid export section name: ${JSON.stringify(section.name)}`);
  }
  const existing = sections.get(section.name);
  if (existing && existing !== section) {
    throw new Error(`Export section "${section.name}" is already registered by another module.`);
  }
  sections.set(section.name, section);
}

/** Test seam: remove a section registered by a test. */
export function unregisterExportSection(name: string): void {
  sections.delete(name);
}

/** Sorted by name, so the bundle layout is deterministic. */
export function listExportSections(): PatientExportSection[] {
  return [...sections.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Keyset pagination helper for sections backed by a table with a unique,
 * monotonic-enough `id` cursor. `fetchPage` returns at most `take` rows
 * after `cursor` (exclusive) in a stable order; `mapPage` turns one page of
 * rows into export items (and is where a section batches any lookups it
 * needs from other modules' services).
 */
export async function* paginate<Row extends { id: string }, Item>(
  pageSize: number,
  fetchPage: (cursor: string | undefined, take: number) => Promise<Row[]>,
  mapPage: (rows: Row[]) => Promise<Item[]> | Item[],
): AsyncGenerator<Item[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('pageSize must be a positive integer.');
  let cursor: string | undefined;
  for (;;) {
    const rows = await fetchPage(cursor, pageSize);
    if (rows.length === 0) return;
    yield await mapPage(rows);
    if (rows.length < pageSize) return;
    cursor = rows[rows.length - 1]!.id;
  }
}
