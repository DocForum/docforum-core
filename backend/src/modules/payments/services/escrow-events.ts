import { prisma } from '../../../db/prisma-client';
import { config } from '../../../config';
import { decodeEscrowRpcEvent } from './escrow-event-decoder';
import { HttpError } from '../../../http-error';
import { logger } from '../../../logger';

type ContractConfig = (typeof config.payments.escrowContracts)[number];
type ChainAlert = {
  id: string;
  contractId: string;
  eventType: string;
  escrowId: string | null;
  ledger: number;
  txHash: string | null;
};

function isRetentionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /retention|oldest ledger|start.?ledger.*(old|window)|ledger.*prun/i.test(message);
}

async function notifyUnmatched(alert: ChainAlert): Promise<void> {
  // Keep the alert useful without including patient data or secrets.
  logger.error({ alert }, '[security:high] unmatched escrow terminal event');
  const url = config.payments.escrowEventAlertWebhookUrl;
  if (!url) return;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ severity: 'high', kind: 'unmatched_escrow_event', ...alert }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) logger.error({ status: response.status }, '[security:high] escrow alert hook returned non-success status');
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.name : typeof error },
      '[security:high] escrow alert hook failed',
    );
  }
}

async function reconcilePending(contractId?: string): Promise<void> {
  const pending = await prisma.escrowChainEvent.findMany({
    where: { state: 'pending', ...(contractId ? { contractId } : {}) },
    orderBy: { detectedAt: 'asc' },
    take: 500,
  });
  const graceMs = 30_000;
  for (const event of pending) {
    const intent = event.escrowId === null ? null : await prisma.paymentIntent.findFirst({
      where: { escrowId: event.escrowId, sorobanContractId: event.contractId },
      select: { id: true, status: true },
    });
    const target = event.eventType === 'released' ? 'released' : event.eventType === 'refunded' ? 'refunded' : 'escrowed';
    if (intent?.status === target) {
      await prisma.escrowChainEvent.updateMany({
        where: { id: event.id, state: 'pending' },
        data: { state: 'matched', paymentIntentId: intent.id },
      });
      continue;
    }
    if (event.eventType !== 'released' && event.eventType !== 'refunded') continue;
    if (Date.now() - event.detectedAt.getTime() < graceMs) continue;
    const updated = await prisma.escrowChainEvent.updateMany({
      where: { id: event.id, state: 'pending' },
      data: { state: 'unmatched', alertedAt: new Date() },
    });
    if (updated.count === 1) {
      await notifyUnmatched({
        id: event.id,
        contractId: event.contractId,
        eventType: event.eventType,
        escrowId: event.escrowId?.toString() ?? null,
        ledger: event.ledger,
        txHash: event.txHash,
      });
    }
  }
}

async function pollContract(contract: ContractConfig): Promise<void> {
  const cursorRow = await prisma.escrowEventCursor.upsert({
    where: { contractId: contract.contractId },
    create: { contractId: contract.contractId, startLedger: contract.startLedger },
    update: {},
  });
  if (cursorRow.catchupError) {
    // Recovery is explicit: configure a reviewed later deployment ledger
    // only after operators reconcile the retention gap, then the poller
    // resumes from that ledger instead of silently skipping old events.
    if (contract.startLedger <= cursorRow.startLedger) return;
    await prisma.escrowEventCursor.update({
      where: { contractId: contract.contractId },
      data: { startLedger: contract.startLedger, cursor: null, catchupError: null },
    });
    cursorRow.cursor = null;
  }
  const { rpc } = await import('@stellar/stellar-sdk');
  const server = new rpc.Server(config.payments.sorobanRpcUrl);
  let cursor = cursorRow.cursor;
  for (let page = 0; page < 20; page += 1) {
    const filters = [{ type: 'contract' as const, contractIds: [contract.contractId] }];
    const response = cursor
      ? await server.getEvents({ filters, limit: 100, cursor })
      : await server.getEvents({ filters, limit: 100, startLedger: cursorRow.startLedger });
    const rows = response.events.map((event: any) => decodeEscrowRpcEvent(event, contract.contractId));
    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        await tx.escrowChainEvent.upsert({
          where: { contractId_eventId: { contractId: row.contractId, eventId: row.eventId } },
          create: row,
          update: {},
        });
      }
      await tx.escrowEventCursor.update({
        where: { contractId: contract.contractId },
        data: {
          cursor: response.cursor,
          lastLedger: response.latestLedger,
          catchupError: null,
        },
      });
    });
    cursor = response.cursor;
    if (rows.length < 100) break;
  }
  await reconcilePending(contract.contractId);
}

export async function pollEscrowContractEvents(): Promise<void> {
  for (const contract of config.payments.escrowContracts) {
    try {
      await pollContract(contract);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRetentionError(error)) {
        const catchupError = `Soroban event retention no longer covers the persisted cursor. Set a reviewed start ledger/cursor and reconcile from ledger ${contract.startLedger}. Details: ${message.slice(0, 300)}`;
        await prisma.escrowEventCursor.updateMany({
          where: { contractId: contract.contractId },
          data: { catchupError },
        });
      }
      logger.error(
        { contractId: contract.contractId, error: error instanceof Error ? error.name : typeof error },
        '[jobs] escrow event poll failed',
      );
    }
  }
  await reconcilePending();
}

type EscrowEventsCursor = { detectedAt: Date; id: string };

/** Opaque keyset cursor over the endpoint's `detectedAt desc, id desc` order. */
export function encodeEscrowEventsCursor(item: { detectedAt: Date; id: string }): string {
  return Buffer.from(`${item.detectedAt.toISOString()}|${item.id}`, 'utf8').toString('base64url');
}

export function decodeEscrowEventsCursor(cursor: string): EscrowEventsCursor {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf('|');
  const detectedAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (separator < 1 || Number.isNaN(detectedAt.getTime()) || !id) {
    throw new HttpError(400, 'Invalid cursor.', 'INVALID_CURSOR');
  }
  return { detectedAt, id };
}

export async function listEscrowEvents(
  limit: number,
  state?: 'pending' | 'matched' | 'unmatched',
  cursor?: string,
) {
  const after = cursor ? decodeEscrowEventsCursor(cursor) : undefined;
  const [rows, cursors] = await Promise.all([
    prisma.escrowChainEvent.findMany({
      where: {
        ...(state ? { state } : {}),
        ...(after
          ? {
              OR: [
                { detectedAt: { lt: after.detectedAt } },
                { detectedAt: after.detectedAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    }),
    prisma.escrowEventCursor.findMany({ orderBy: { contractId: 'asc' } }),
  ]);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: items.map((event) => ({ ...event, escrowId: event.escrowId?.toString() ?? null })),
    cursors,
    nextCursor: rows.length > limit && last ? encodeEscrowEventsCursor(last) : null,
  };
}
