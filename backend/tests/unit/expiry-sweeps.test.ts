import { describe, expect, it } from 'vitest';
import { runBatchedSweep, type SweepLogger } from '../../src/jobs/expiry-sweeps';

function rows(count: number, prefix = 'row'): Array<{ id: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${String(index + 1).padStart(3, '0')}` }));
}

function fakeLogger() {
  const calls: Array<{ fields: Record<string, unknown>; message?: string }> = [];
  const logger: SweepLogger = {
    info: (fields, message) => {
      calls.push({ fields, message });
    },
  };
  return { logger, calls };
}

describe('runBatchedSweep', () => {
  it('processes more rows than one batch and advances the id cursor', async () => {
    const all = rows(5);
    const cursors: Array<string | null> = [];
    const limits: number[] = [];
    const processed: string[][] = [];

    const result = await runBatchedSweep<{ id: string }, string>({
      job: 'test-order-expiry',
      batchSize: 2,
      maxPerRun: 10,
      selectBatch: async (afterId, limit) => {
        cursors.push(afterId);
        limits.push(limit);
        const start = all.findIndex((row) => row.id > (afterId ?? ''));
        return start === -1 ? [] : all.slice(start, start + limit);
      },
      cursorFrom: (row) => row.id,
      processBatch: async (batch) => {
        processed.push(batch.map((row) => row.id));
        return { expired: batch.length, skipped: 0 };
      },
    });

    expect(result).toEqual({ selected: 5, expired: 5, skipped: 0, batches: 3, capHit: false });
    expect(cursors).toEqual([null, 'row-002', 'row-004']);
    expect(limits).toEqual([2, 2, 2]);
    expect(processed).toEqual([all.slice(0, 2).map((r) => r.id), all.slice(2, 4).map((r) => r.id), [all[4].id]]);
  });

  it('handles an exact multiple of the batch size without losing a row', async () => {
    const all = rows(4);
    let offset = 0;

    const result = await runBatchedSweep<{ id: string }, string>({
      job: 'test-order-expiry',
      batchSize: 2,
      maxPerRun: 10,
      selectBatch: async (_afterId, limit) => {
        const batch = all.slice(offset, offset + limit);
        offset += batch.length;
        return batch;
      },
      cursorFrom: (row) => row.id,
      processBatch: async (batch) => ({ expired: batch.length, skipped: 0 }),
    });

    expect(result.selected).toBe(4);
    expect(result.batches).toBe(2);
    expect(result.capHit).toBe(false);
  });

  it('returns an empty result for no eligible rows', async () => {
    const { logger, calls } = fakeLogger();
    const result = await runBatchedSweep<{ id: string }, string>({
      job: 'test-order-expiry',
      batchSize: 2,
      maxPerRun: 10,
      logger,
      selectBatch: async () => [],
      cursorFrom: (row) => row.id,
      processBatch: async () => ({ expired: 0, skipped: 0 }),
    });

    expect(result).toEqual({ selected: 0, expired: 0, skipped: 0, batches: 0, capHit: false });
    expect(calls).toEqual([
      {
        fields: { job: 'test-order-expiry', selected: 0, expired: 0, skipped: 0, batches: 0, capHit: false },
        message: 'expiry sweep complete',
      },
    ]);
  });

  it('stops at the per-run cap and reports that work remains', async () => {
    const all = rows(6);
    let offset = 0;

    const result = await runBatchedSweep<{ id: string }, string>({
      job: 'test-order-expiry',
      batchSize: 2,
      maxPerRun: 3,
      selectBatch: async (_afterId, limit) => {
        const batch = all.slice(offset, offset + limit);
        offset += batch.length;
        return batch;
      },
      cursorFrom: (row) => row.id,
      processBatch: async (batch) => ({ expired: batch.length, skipped: 0 }),
    });

    expect(result.selected).toBe(3);
    expect(result.batches).toBe(2);
    expect(result.capHit).toBe(true);
    expect(offset).toBe(3);
  });

  it('logs selected, expired and skipped once per batch plus a final summary', async () => {
    const { logger, calls } = fakeLogger();
    const result = await runBatchedSweep<{ id: string }, string>({
      job: 'test-lab-expiry',
      batchSize: 2,
      maxPerRun: 10,
      logger,
      selectBatch: async (afterId) => {
        const all = rows(3);
        const start = all.findIndex((row) => row.id > (afterId ?? ''));
        return start === -1 ? [] : all.slice(start, start + 2);
      },
      cursorFrom: (row) => row.id,
      processBatch: async (batch) => ({ expired: 1, skipped: batch.length - 1 }),
    });

    expect(result).toEqual({ selected: 3, expired: 2, skipped: 1, batches: 2, capHit: false });
    expect(calls.map((call) => call.fields)).toEqual([
      { job: 'test-lab-expiry', batch: 1, selected: 2, expired: 1, skipped: 1, capHit: false },
      { job: 'test-lab-expiry', batch: 2, selected: 1, expired: 1, skipped: 0, capHit: false },
      { job: 'test-lab-expiry', selected: 3, expired: 2, skipped: 1, batches: 2, capHit: false },
    ]);
  });
});
