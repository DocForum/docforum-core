import type { OutboxEvent, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma-client';

const uuid = z.string().uuid();

export const eventPayloadSchemas = {
	'appointment.booked': z.object({ appointmentId: uuid, patientUserId: uuid }).strict(),
} as const;

export type DomainEventType = keyof typeof eventPayloadSchemas;
export type DomainEvent<T extends DomainEventType = DomainEventType> = {
	id: string;
	type: T;
	payload: z.infer<(typeof eventPayloadSchemas)[T]>;
	attempts: number;
};
export type DomainEventHandler<T extends DomainEventType = DomainEventType> = (event: DomainEvent<T>) => Promise<void>;

const handlers = new Map<DomainEventType, DomainEventHandler>();

/** Persist an event using the caller's Prisma transaction; never call a handler here. */
export async function publish<T extends DomainEventType>(
	tx: Prisma.TransactionClient,
	type: T,
	payload: unknown,
): Promise<OutboxEvent> {
	const parsed = eventPayloadSchemas[type].parse(payload);
	return tx.outboxEvent.create({ data: { type, payload: parsed as Prisma.InputJsonValue } });
}

export function registerHandler<T extends DomainEventType>(type: T, handler: DomainEventHandler<T>): () => void {
	if (handlers.has(type)) throw new Error(`Handler already registered for ${type}`);
	handlers.set(type, handler as DomainEventHandler);
	return () => {
		if (handlers.get(type) === handler) handlers.delete(type);
	};
}

export function getHandler(type: string): DomainEventHandler | undefined {
	return handlers.get(type as DomainEventType);
}

export function listDeadLetterEvents(limit = 50) {
	return prisma.outboxEvent.findMany({
		where: { status: 'dead' },
		select: { id: true, type: true, attempts: true, lastError: true, createdAt: true, deadLetteredAt: true },
		orderBy: [{ deadLetteredAt: 'desc' }, { id: 'desc' }],
		take: limit,
	});
}