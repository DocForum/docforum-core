// Lab-order expiry (Phase 4, issue #12 — batched in issue #348, with the
// refund trigger of issue #84).
//
// A lab order that was never fulfilled by its `expiresAt` moves
// `issued -> expired` through ONE conditional UPDATE per row, and the
// `order.expired` outbox event is inserted in the SAME transaction. The
// payments worker therefore refunds exactly the orders whose expiry
// committed — a crashed job, a concurrent fulfilment, or a second process
// cannot refund an order that never expired, and cannot expire a fulfilled
// one (the `status: 'issued'` predicate is the guard).
//
// Batching uses a composite keyset cursor (`expiresAt`, `id`): each bounded
// batch is selected in the original oldest-first order, then each row keeps
// its own transaction and conditional UPDATE/event pair, so a racing sweeper
// cannot double-publish. A run that hits the cap leaves the remaining
// eligible rows for the next scheduled tick.
//
// Prescriptions have no `expiresAt` column (ARCHITECTURE.md §4.5), so there is
// no prescription-expiry trigger here; that is a documented gap, not an
// omission hidden behind a generic "order" sweep.
import { prisma } from '../db/prisma-client';
import { config } from '../config';
import { publish } from '../events';
import { logger } from '../logger';
import { runBatchedSweep, type SweepLogger } from './expiry-sweeps';

type LabCursor = { expiresAt: Date; id: string };

export interface LabOrderExpirySweepOptions {
  /** Defaults to config.expirySweeps.batchSize. */
  batchSize?: number;
  logger?: SweepLogger;
}

/** Detailed sweep result, exported for tests and manual invocation. */
export async function runExpireUnfulfilledOrders(
  now: Date = new Date(),
  max: number = config.expirySweeps.maxPerRun,
  options: LabOrderExpirySweepOptions = {},
): Promise<{ expired: number; selected: number; skipped: number; batches: number; capHit: boolean }> {
  const sweep = await runBatchedSweep<
    { id: string; expiresAt: Date | null },
    LabCursor
  >({
    job: 'lab-order-expiry',
    batchSize: options.batchSize ?? config.expirySweeps.batchSize,
    maxPerRun: max,
    logger: options.logger ?? logger,
    selectBatch: (after, limit) =>
      prisma.labOrder.findMany({
        where: {
          status: 'issued',
          expiresAt: { not: null, lte: now },
          ...(after === null
            ? {}
            : {
                OR: [
                  { expiresAt: { gt: after.expiresAt } },
                  { expiresAt: after.expiresAt, id: { gt: after.id } },
                ],
              }),
        },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take: limit,
        select: { id: true, expiresAt: true },
      }),
    cursorFrom: (row) => ({ expiresAt: row.expiresAt as Date, id: row.id }),
    processBatch: async (rows) => {
      let expired = 0;
      for (const row of rows) {
        await prisma.$transaction(async (tx) => {
          const result = await tx.labOrder.updateMany({
            where: {
              id: row.id,
              status: 'issued',
              expiresAt: { not: null, lte: now },
            },
            data: { status: 'expired' },
          });
          if (result.count === 1) {
            await publish(tx, 'order.expired', { orderType: 'lab_order', orderId: row.id });
            expired += 1;
          }
        });
      }
      return { expired, skipped: rows.length - expired };
    },
  });

  return { expired: sweep.expired, selected: sweep.selected, skipped: sweep.skipped, batches: sweep.batches, capHit: sweep.capHit };
}

/** Backwards-compatible entry point: the scheduler and existing tests expect a count. */
export async function expireUnfulfilledOrders(
  now: Date = new Date(),
  max: number = config.expirySweeps.maxPerRun,
  options: LabOrderExpirySweepOptions = {},
): Promise<number> {
  return (await runExpireUnfulfilledOrders(now, max, options)).expired;
}
