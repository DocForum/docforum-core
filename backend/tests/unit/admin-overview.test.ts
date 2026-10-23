import { describe, expect, it, vi } from 'vitest';
import { createOverviewCache, runOverviewSections } from '../../src/utils/admin-overview';

const NOW = new Date('2026-10-23T10:00:00Z');

describe('runOverviewSections', () => {
  it('reports each section with its count and oldest age', async () => {
    const overview = await runOverviewSections(
      [
        {
          key: 'doctor-verification',
          label: 'Doctors awaiting verification',
          drillDownPath: '/doctors?verificationStatus=pending',
          run: async () => ({ count: 3, oldestAgeSeconds: 7200 }),
        },
      ],
      NOW,
    );
    expect(overview.generatedAt).toBe(NOW.toISOString());
    expect(overview.sections[0]).toEqual({
      key: 'doctor-verification',
      label: 'Doctors awaiting verification',
      drillDownPath: '/doctors?verificationStatus=pending',
      status: 'ok',
      count: 3,
      oldestAgeSeconds: 7200,
    });
  });

  it('marks a failing section unavailable without failing the others', async () => {
    const overview = await runOverviewSections(
      [
        { key: 'broken', label: 'Broken', drillDownPath: '/broken', run: async () => { throw new Error('db down'); } },
        { key: 'fine', label: 'Fine', drillDownPath: '/fine', run: async () => ({ count: 0, oldestAgeSeconds: null }) },
      ],
      NOW,
    );
    const broken = overview.sections.find((s) => s.key === 'broken');
    const fine = overview.sections.find((s) => s.key === 'fine');
    expect(broken).toMatchObject({ status: 'unavailable', count: null, oldestAgeSeconds: null });
    expect(fine).toMatchObject({ status: 'ok', count: 0 });
  });

  it('does not leak the error message into the response', async () => {
    const overview = await runOverviewSections(
      [{ key: 'x', label: 'X', drillDownPath: '/x', run: async () => { throw new Error('secret connection string'); } }],
      NOW,
    );
    expect(JSON.stringify(overview)).not.toContain('secret connection string');
  });
});

describe('createOverviewCache', () => {
  it('reuses the overview within the TTL and rebuilds after it', async () => {
    let now = 0;
    const build = vi.fn(async () => ({ generatedAt: 'x', sections: [] }));
    const cached = createOverviewCache(build, 60_000, () => now);

    await cached();
    now = 59_999;
    await cached();
    expect(build).toHaveBeenCalledTimes(1);

    now = 60_000;
    await cached();
    expect(build).toHaveBeenCalledTimes(2);
  });
});
