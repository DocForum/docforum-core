import { prisma } from '../db/prisma-client';
import { config } from '../config';
import { record, SYSTEM_ACTOR } from '../modules/audit/services';

export async function expireUnconfirmedOrders(
  windowHours: number = config.orders.confirmationWindowHours,
): Promise<{ confirmedCount: number }> {
  const threshold = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const eligibleOrders = await prisma.order.findMany({
    where: {
      status: 'fulfilled',
      confirmed: false,
      disputed: false,
      fulfilledAt: {
        lt: threshold,
      },
    },
    select: {
      id: true,
    },
  });

  if (eligibleOrders.length === 0) {
    return { confirmedCount: 0 };
  }

  let confirmedCount = 0;

  for (const eligible of eligibleOrders) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: {
          id: eligible.id,
          status: 'fulfilled',
          confirmed: false,
          disputed: false,
          fulfilledAt: {
            lt: threshold,
          },
        },
        data: {
          confirmed: true,
          confirmedAt: new Date(),
          confirmationSource: 'timeout',
        },
      });

      if (updated.count > 0) {
        confirmedCount += updated.count;
        await record(tx, SYSTEM_ACTOR, {
          entityType: 'Order',
          entityId: eligible.id,
          action: 'order.receipt_confirmed',
          fromState: 'fulfilled',
          toState: 'confirmed',
          metadata: { confirmationSource: 'timeout' },
        });
      }
    });
  }

  return { confirmedCount };
}

export function startOrderExpiryJob(): () => void {
  const run = async () => {
    try {
      const { confirmedCount } = await expireUnconfirmedOrders();
      if (confirmedCount > 0) {
        // eslint-disable-next-line no-console
        console.log(`[jobs] auto-confirmed ${confirmedCount} order(s) past confirmation window`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[jobs] order expiry job failed:', err instanceof Error ? err.name : typeof err);
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
