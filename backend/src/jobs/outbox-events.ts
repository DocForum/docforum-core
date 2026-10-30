import { Prisma, type OutboxEventStatus } from '@prisma/client';
import { prisma } from '../db/prisma-client';
import { getHandler, type DomainEvent } from '../events';
import { registerDomainEventHandlers } from '../events/handlers';

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 60_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60 * 60 * 1000;
const WORKER_INTERVAL_MS = 5_000;

type ClaimedEvent = {
	id: string;
	type: string;
	payload: Prisma.JsonValue;
	attempts: number;
	createdAt: Date;
};

async function claimEvents(batchSize: number): Promise<ClaimedEvent[]> {
	const staleBefore = new Date(Date.now() - LEASE_MS);
	return prisma.$transaction(async (tx) => {
		await tx.outboxEvent.updateMany({
			where: { status: 'processing', attempts: { gte: MAX_ATTEMPTS }, lockedAt: { lte: staleBefore } },
			data: { status: 'dead', deadLetteredAt: new Date(), lockedAt: null, lastError: 'MAX_ATTEMPTS_EXCEEDED' },
		});
		return tx.$queryRaw<ClaimedEvent[]>(Prisma.sql`
			WITH candidates AS (
				SELECT "id"
				FROM "OutboxEvent"
				WHERE "attempts" < ${MAX_ATTEMPTS}
					AND (
						("status" = 'pending' AND "availableAt" <= NOW())
						OR ("status" = 'processing' AND "lockedAt" <= ${staleBefore})
					)
				ORDER BY "createdAt", "id"
				FOR UPDATE SKIP LOCKED
				LIMIT ${batchSize}
			)
			UPDATE "OutboxEvent" AS event
			SET "status" = 'processing', "attempts" = event."attempts" + 1, "lockedAt" = NOW()
			FROM candidates
			WHERE event."id" = candidates."id"
			RETURNING event."id", event."type", event."payload", event."attempts", event."createdAt"
		`);
	});
}

function retryDelay(attempt: number): number {
	return Math.min(RETRY_BASE_MS * 2 ** Math.max(attempt - 1, 0), RETRY_MAX_MS);
}

async function updateClaim(
	eventId: string,
	attempts: number,
	data: { status: OutboxEventStatus; processedAt?: Date | null; deadLetteredAt?: Date | null; lockedAt?: Date | null; lastError?: string | null; availableAt?: Date },
) {
	await prisma.outboxEvent.updateMany({ where: { id: eventId, status: 'processing', attempts }, data });
}

export async function dispatchOutboxOnce(batchSize = BATCH_SIZE) {
	const events = await claimEvents(Math.max(1, Math.min(100, Math.floor(batchSize))));
	let processed = 0;
	let failed = 0;

	for (const row of events) {
		const handler = getHandler(row.type);
		if (!handler) {
			await updateClaim(row.id, row.attempts, {
				status: 'dead',
				deadLetteredAt: new Date(),
				lockedAt: null,
				lastError: 'NO_HANDLER',
			});
			failed += 1;
			continue;
		}

		try {
			await handler({
				id: row.id,
				type: row.type as DomainEvent['type'],
				payload: row.payload as DomainEvent['payload'],
				attempts: row.attempts,
			});
			await updateClaim(row.id, row.attempts, {
				status: 'processed',
				processedAt: new Date(),
				lockedAt: null,
				lastError: null,
			});
			processed += 1;
		} catch {
			const exhausted = row.attempts >= MAX_ATTEMPTS;
			await updateClaim(row.id, row.attempts, {
				status: exhausted ? 'dead' : 'pending',
				deadLetteredAt: exhausted ? new Date() : null,
				lockedAt: null,
				lastError: 'HANDLER_FAILED',
				availableAt: new Date(Date.now() + retryDelay(row.attempts)),
			});
			failed += 1;
		}
	}

	return { claimed: events.length, processed, failed };
}

export function startOutboxEventJobs(): void {
	registerDomainEventHandlers();
	const timer = setInterval(() => {
		void dispatchOutboxOnce().catch(() => {
			// Do not log event payloads or driver messages; they may contain sensitive data.
			console.error('[jobs] outbox dispatch failed');
		});
	}, WORKER_INTERVAL_MS);
	timer.unref();
}