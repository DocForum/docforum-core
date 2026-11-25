import { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma-client';
import { normalizedPhone } from '../../../config/sections/notifications';

type DbClient = typeof prisma | Prisma.TransactionClient;

export async function setSmsConsent(userId: string, phone: string, status: 'opted_in' | 'opted_out') {
	const normalized = normalizedPhone(phone);
	return prisma.$executeRaw(Prisma.sql`
		INSERT INTO "SmsConsent" ("id", "userId", "phone", "status", "updatedAt", "createdAt")
		VALUES (gen_random_uuid(), ${userId}, ${normalized}, CAST(${status} AS "SmsConsentStatus"), NOW(), NOW())
		ON CONFLICT ("userId", "phone") DO UPDATE SET "status" = EXCLUDED."status", "updatedAt" = NOW()
	`);
}

export function setSmsConsentForPhone(phone: string, status: 'opted_in' | 'opted_out') {
	return prisma.$executeRaw(Prisma.sql`
		UPDATE "SmsConsent" SET "status" = CAST(${status} AS "SmsConsentStatus"), "updatedAt" = NOW()
		WHERE "phone" = ${normalizedPhone(phone)}
	`);
}

export async function hasSmsConsent(phone: string): Promise<boolean> {
	const rows = await prisma.$queryRaw<Array<{ status: string }>>(Prisma.sql`
		SELECT "status" FROM "SmsConsent" WHERE "phone" = ${normalizedPhone(phone)}
		ORDER BY "updatedAt" DESC LIMIT 1
	`);
	return rows[0]?.status === 'opted_in';
}

export async function smsSentToday(phone: string): Promise<number> {
	const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
		SELECT COUNT(*)::bigint AS count FROM "NotificationDelivery"
		WHERE "channel" = 'sms' AND "destination" = ${normalizedPhone(phone)}
		AND "createdAt" >= CURRENT_DATE
	`);
	return Number(rows[0]?.count ?? 0);
}

export function recordDelivery(input: { notificationId: string; channel: 'email' | 'sms'; destination: string; status: string; providerMessageId?: string; error?: string }) {
	return prisma.$executeRaw(Prisma.sql`
		INSERT INTO "NotificationDelivery" ("id", "notificationId", "channel", "destination", "status", "providerMessageId", "error", "createdAt", "updatedAt")
		VALUES (gen_random_uuid(), ${input.notificationId}, CAST(${input.channel} AS "NotificationChannel"), ${input.destination}, CAST(${input.status} AS "NotificationDeliveryStatus"), ${input.providerMessageId ?? null}, ${input.error ?? null}, NOW(), NOW())
	`);
}

export function updateDeliveryByProviderId(providerMessageId: string, status: string, error?: string) {
	return prisma.$executeRaw(Prisma.sql`
		UPDATE "NotificationDelivery" SET "status" = CAST(${status} AS "NotificationDeliveryStatus"), "error" = ${error ?? null}, "updatedAt" = NOW()
		WHERE "providerMessageId" = ${providerMessageId}
	`);
}

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

/** Issue #330: publish one cross-instance fan-out message. pg_notify takes
 * the channel as a parameter, so neither value is ever spliced into SQL.
 * Runs on the shared pool (it is a one-shot statement); only LISTEN needs
 * a dedicated connection. */
export async function pgNotify(channel: string, payload: string): Promise<void> {
	await prisma.$executeRaw`SELECT pg_notify(${channel}, ${payload})`;
}
