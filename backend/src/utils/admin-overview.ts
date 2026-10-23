// Admin operations overview (Phase 8, issue #123). Each module contributes one
// section through its own service. This file only runs them, isolates
// failures, and caches the result briefly.
//
// Rules for a section: count and age only, never PHI or patient names. A
// section that throws is reported as `unavailable`. It does not fail the
// whole overview.

export interface AdminOverviewSection {
  key: string;
  label: string;
  status: 'ok' | 'unavailable';
  /** Number of items waiting in this queue. Null when unavailable. */
  count: number | null;
  /** Age in seconds of the oldest waiting item. Null when empty or unavailable. */
  oldestAgeSeconds: number | null;
  /** Where an admin goes to see the items. */
  drillDownPath: string;
}

export interface AdminOverviewSectionDefinition {
  key: string;
  label: string;
  drillDownPath: string;
  /** Returns the count and age for this section. Throwing marks it unavailable. */
  run: () => Promise<{ count: number; oldestAgeSeconds: number | null }>;
}

export interface AdminOverview {
  generatedAt: string;
  sections: AdminOverviewSection[];
}

export const OVERVIEW_CACHE_TTL_MS = 60_000;

/** Run every section in parallel. A rejected section becomes `unavailable`. */
export async function runOverviewSections(
  sections: readonly AdminOverviewSectionDefinition[],
  now: Date = new Date(),
): Promise<AdminOverview> {
  const results = await Promise.all(
    sections.map(async (section): Promise<AdminOverviewSection> => {
      try {
        const data = await section.run();
        return {
          key: section.key,
          label: section.label,
          drillDownPath: section.drillDownPath,
          status: 'ok',
          count: data.count,
          oldestAgeSeconds: data.oldestAgeSeconds,
        };
      } catch {
        return {
          key: section.key,
          label: section.label,
          status: 'unavailable',
          count: null,
          oldestAgeSeconds: null,
          drillDownPath: section.drillDownPath,
        };
      }
    }),
  );
  return { generatedAt: now.toISOString(), sections: results };
}

/** Returns the cached overview while it is younger than the TTL, otherwise rebuilds it. */
export function createOverviewCache(build: () => Promise<AdminOverview>, ttlMs = OVERVIEW_CACHE_TTL_MS, clock = Date.now) {
  let entry: { at: number; value: AdminOverview } | null = null;
  return async (): Promise<AdminOverview> => {
    const current = clock();
    if (entry && current - entry.at < ttlMs) return entry.value;
    const value = await build();
    entry = { at: current, value };
    return value;
  };
}
