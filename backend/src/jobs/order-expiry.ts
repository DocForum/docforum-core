// Unconfirmed-order expiry (Phase 4, issue #76; batched in issue #348).
//
// A fulfilled order that is still unconfirmed and undisputed past the
// confirmation window is auto-confirmed. Each row keeps its own transaction:
// the conditional UPDATE re-checks the full eligibility predicate, and the
// audit event is written in that same transaction only when a row was
// actually changed. Two sweepers can therefore run at once — the loser of a
// race sees count 0 and writes no second audit event. No index or schema
// change is needed: the keyset cursor is the id primary key, and the
// eligibility predicate is already indexed by (status, confirmed, disputed).
import { prisma } from '../db/prisma-client';
import { config } from '../config';
import { record, SYSTEM_ACTOR } from '../modules/audit/services';
import { logger } from '../logger';
import { runBatchedSweep, type SweepLogger } from './expiry-sweeps';

export interface OrderExpirySweepOptions {
  /** Defaults to config.expirySweeps.batchSize. */
  batchSize?: number;
  /** Defaults to config.expirySweeps.maxPerRun. */
  maxPerRun?: number;
  logger?: SweepLogger;
}

export async function expireUnconfirmedOrders(
  windowHours: number = config.orders.confirmationWindowHours,
  options: OrderExpirySweepOptions = {},
): Promise<{
  confirmedCount: number;
  selectedCount: number;
  skippedCount: number;
  batches: number;
  capHit: boolean;
}> {
  const threshold = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const sweep = await runBatchedSweep<{ id: string }, string>({
    job: 'order-expiry',
    batchSize: options.batchSize ?? config.expirySweeps.batchSize,
    maxPerRun: options.maxPerRun ?? config.expirySweeps.maxPerRun,
    logger: options.logger ?? logger,
    selectBatch: (afterId, limit) =>
      prisma.order.findMany({
        where: {
          ...(afterId === null ? {} : { id: { gt: afterId } }),
          status: 'fulfilled',
          confirmed: false,
          disputed: false,
          fulfilledAt: { lt: threshold },
        },
        orderBy: { id: 'asc' },
        take: limit,
        select: { id: true },
      }),
    cursorFrom: (row) => row.id,
    processBatch: async (rows) => {
      let confirmed = 0;
      for (const row of rows) {
        await prisma.$transaction(async (tx) => {
          const updated = await tx.order.updateMany({
            where: {
              id: row.id,
              status: 'fulfilled',
              confirmed: false,
              disputed: false,
              fulfilledAt: { lt: threshold },
            },
            data: {
              confirmed: true,
              confirmedAt: new Date(),
              confirmationSource: 'timeout',
            },
          });

          if (updated.count > 0) {
            confirmed += updated.count;
            await record(tx, SYSTEM_ACTOR, {
              entityType: 'Order',
              entityId: row.id,
              action: 'order.receipt_confirmed',
              fromState: 'fulfilled',
              toState: 'confirmed',
              metadata: { confirmationSource: 'timeout' },
            });
          }
        });
      }
      return { expired: confirmed, skipped: rows.length - confirmed };
    },
  });

  return {
    confirmedCount: sweep.expired,
    selectedCount: sweep.selected,
    skippedCount: sweep.skipped,
    batches: sweep.batches,
    capHit: sweep.capHit,
  };
}

export function startOrderExpiryJob(): () => void {
  const run = async () => {
    try {
      await expireUnconfirmedOrders();
      // runBatchedSweep already emitted the per-batch and final count logs.
    } catch (err) {
      logger.error({ errType: err instanceof Error ? err.name : typeof err }, 'order expiry job failed');
    }
  };

  const timer = setInterval(run, config.orders.expiryIntervalSeconds * 1000);
  timer.unref();

  // Pick up any pending unconfirmed orders on startup
  void run();

  return () => {
    clearInterval(timer);
  };
}
