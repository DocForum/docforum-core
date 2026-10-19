import type { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma-client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function createNotification(
	userId: string,
	type: string,
	payload: Prisma.InputJsonValue,
	sourceEventId?: string,
	db: DbClient = prisma,
) {
	if (!sourceEventId) {
		return db.notification.create({ data: { userId, type, payload, channel: 'in_app' } }).then((notification) => ({ notification, created: true }));
	}
	return db.notification
		.createMany({
			data: { userId, type, payload, sourceEventId, channel: 'in_app' },
			skipDuplicates: true,
		})
		.then(async ({ count }) => ({
			notification: await db.notification.findUniqueOrThrow({ where: { sourceEventId } }),
			created: count > 0,
		}));
}

export function listNotifications(
	userId: string,
	options: { unreadOnly: boolean; limit: number; cursor?: { createdAt: Date; id: string } },
) {
	return prisma.notification.findMany({
		where: {
			userId,
			...(options.unreadOnly ? { readAt: null } : {}),
			...(options.cursor
				? {
						OR: [
							{ createdAt: { lt: options.cursor.createdAt } },
							{ createdAt: options.cursor.createdAt, id: { lt: options.cursor.id } },
						],
					}
				: {}),
		},
		orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
		take: options.limit + 1,
	});
}

export function countUnread(userId: string) {
	return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function markNotificationRead(userId: string, id: string) {
	const updated = await prisma.notification.updateMany({
		where: { id, userId, readAt: null },
		data: { readAt: new Date() },
	});
	if (updated.count > 0) return prisma.notification.findUniqueOrThrow({ where: { id } });
	return prisma.notification.findFirst({ where: { id, userId } });
}

export function markAllNotificationsRead(userId: string) {
	return prisma.notification.updateMany({
		where: { userId, readAt: null },
		data: { readAt: new Date() },
	});
}
