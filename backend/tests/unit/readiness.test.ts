import { describe, expect, it, vi } from 'vitest';
import { createReadinessChecker, type ReadinessChecks } from '../../src/health/readiness';

function checks(overrides: Partial<ReadinessChecks> = {}): ReadinessChecks {
  return {
    configuration: vi.fn(async () => {}),
    database: vi.fn(async () => {}),
    migrations: vi.fn(async () => {}),
    payments: vi.fn(async () => 'disabled' as const),
    ...overrides,
  };
}

describe('readiness checks', () => {
  it('fails readiness when Postgres is unreachable', async () => {
    const getReadiness = createReadinessChecker(checks({ database: async () => { throw new Error('db down'); } }));
    await expect(getReadiness()).resolves.toMatchObject({
      status: 'not_ready',
      checks: { database: 'failed' },
    });
  });

  it('fails readiness when migrations are not at the application version', async () => {
    const getReadiness = createReadinessChecker(checks({ migrations: async () => { throw new Error('migration pending'); } }));
    await expect(getReadiness()).resolves.toMatchObject({
      status: 'not_ready',
      checks: { migrations: 'pending' },
    });
  });

  it('keeps payment RPC failure visible without taking the API out of readiness', async () => {
    const getReadiness = createReadinessChecker(checks({ payments: async () => 'unavailable' }));
    await expect(getReadiness()).resolves.toMatchObject({
      status: 'ready',
      checks: { payments: 'unavailable' },
    });
  });

  it('caches the result briefly to avoid repeated database probes', async () => {
    const database = vi.fn(async () => {});
    const getReadiness = createReadinessChecker(checks({ database }), 3_000);
    await getReadiness();
    await getReadiness();
    expect(database).toHaveBeenCalledTimes(1);
  });
});
