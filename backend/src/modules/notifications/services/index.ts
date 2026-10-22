// notifications services — the only exported surface other modules may
// call. Other modules must only import from here, never from
// repositories/ directly. See AGENTS.md "Non-negotiable rules".
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import { formatMessage, resolveLocale } from '../../../i18n';
import * as notificationsRepo from '../repositories';

export interface NotificationMessage {
  to: string;
  subject: string;
  body: string;
}

export interface NotificationChannel {
  send(message: NotificationMessage): Promise<void>;
}

export const consoleNotificationChannel: NotificationChannel = {
  async send(message) {
    console.log(`[notifications] → ${message.to}\n${message.subject}\n${message.body}`);
  },
};

let channel: NotificationChannel = consoleNotificationChannel;

export function setNotificationChannel(next: NotificationChannel): NotificationChannel {
  const previous = channel;
  channel = next;
  return previous;
}

export function send(message: NotificationMessage): Promise<void> {
  return channel.send(message);
}

export async function sendPasswordResetLink(input: {
  email: string;
  token: string;
  expiresAt: Date;
  locale?: string;
}): Promise<void> {
  const link = `${config.appBaseUrl}/reset-password?token=${encodeURIComponent(input.token)}`;
  const minutes = Math.round((input.expiresAt.getTime() - Date.now()) / 60_000);
  const locale = resolveLocale(input.locale);
  await send({
    to: input.email,
    subject: formatMessage(locale, 'notifications.passwordReset.subject'),
    body: formatMessage(locale, 'notifications.passwordReset.body', { minutes, link }),
  });
}

const uuid = z.string().uuid();

export const notificationPayloadSchemas = {
  booking_confirmed: z.object({ appointmentId: uuid }).strict(),
  new_booking: z.object({ appointmentId: uuid }).strict(),
  referral_created: z.object({ referralId: uuid }).strict(),
  referral_updated: z.object({ referralId: uuid }).strict(),
  order_ready: z.object({ orderId: uuid, orderType: z.enum(['prescription', 'lab_order']) }).strict(),
  results_available: z.object({ labOrderId: uuid }).strict(),
} as const;

export type NotificationType = keyof typeof notificationPayloadSchemas;
export type NotificationPayload<T extends NotificationType> = z.infer<(typeof notificationPayloadSchemas)[T]>;
export type NotificationDispatch = {
  notificationId: string;
  userId: string;
  type: NotificationType;
  payload: NotificationPayload<NotificationType>;
};

export interface NotificationChannelAdapter {
  channel: 'email' | 'sms';
  send(notification: NotificationDispatch): Promise<void>;
}

const adapters = new Set<NotificationChannelAdapter>();

export function registerChannelAdapter(adapter: NotificationChannelAdapter): () => void {
  adapters.add(adapter);
  return () => adapters.delete(adapter);
}

export async function notify<T extends NotificationType>(
  userId: string,
  type: T,
  payload: unknown,
  options: { sourceEventId?: string } = {},
) {
  const parsed = notificationPayloadSchemas[type].safeParse(payload);
  if (!parsed.success) throw new HttpError(400, 'Invalid notification payload.', 'INVALID_NOTIFICATION_PAYLOAD');

  const persisted = await notificationsRepo.createNotification(
    userId,
    type,
    parsed.data as Prisma.InputJsonValue,
    options.sourceEventId,
  );
  const notification = persisted.notification;
  const dispatch: NotificationDispatch = {
    notificationId: notification.id,
    userId,
    type,
    payload: parsed.data as NotificationPayload<NotificationType>,
  };

  if (persisted.created) {
    const registeredAdapters = [...adapters];
    const results = await Promise.allSettled(
      registeredAdapters.map((adapter) => Promise.resolve().then(() => adapter.send(dispatch))),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`[notifications] ${registeredAdapters[index]?.channel ?? 'unknown'} adapter failed for notification ${notification.id}`);
      }
    });
  }
  return notification;
}

export async function listMyNotifications(
  userId: string,
  options: { unreadOnly: boolean; limit: number; cursor?: string },
) {
  const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
  const rows = await notificationsRepo.listNotifications(userId, { ...options, cursor });
  const hasMore = rows.length > options.limit;
  const items = hasMore ? rows.slice(0, options.limit) : rows;
  return { items, nextCursor: hasMore ? encodeCursor(items[items.length - 1]) : null };
}

export function getUnreadCount(userId: string) {
  return notificationsRepo.countUnread(userId);
}

export async function markMyNotificationRead(userId: string, id: string) {
  const notification = await notificationsRepo.markNotificationRead(userId, id);
  if (!notification) throw new HttpError(404, 'Notification not found.');
  return notification;
}

export function markAllMyNotificationsRead(userId: string) {
  return notificationsRepo.markAllNotificationsRead(userId);
}

function encodeCursor(notification: { createdAt: Date; id: string }): string {
  return Buffer.from(`${notification.createdAt.toISOString()}|${notification.id}`).toString('base64url');
}

function decodeCursor(value: string): { createdAt: Date; id: string } {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const separator = decoded.indexOf('|');
    const createdAtText = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    const createdAt = new Date(createdAtText);
    if (
      separator < 1 ||
      !Number.isFinite(createdAt.getTime()) ||
      createdAt.toISOString() !== createdAtText ||
      !uuid.safeParse(id).success
    ) {
      throw new Error('Invalid cursor');
    }
    return { createdAt, id };
  } catch {
    throw new HttpError(400, 'Invalid cursor.', 'INVALID_CURSOR');
  }
}
