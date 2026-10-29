import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';
import * as notificationsRepo from '../repositories';
import { config } from '../../../config';
import { formatMessage, resolveLocale } from '../../../i18n';

/**
 * Notification dispatch interface (Phase 6, issue #17).
 *
 * This module owns the transactional outbox. Other modules enqueue
 * notifications by calling `enqueue` from inside their own transaction — the
 * outbox row commits atomically with the business write, so a notification
 * exists if and only if the write committed. Delivery happens out-of-band
 * (the dispatcher job), never inline in the request path.
 */

export type NotificationKind =
  | 'booking_confirmed'
  | 'new_booking'
  | 'appointment_reminder_24h'
  | 'appointment_reminder_2h'
  | 'appointment_cancelled'
  | 'appointment_rescheduled';

export type NotificationChannelName = 'email';

export interface EnqueueNotificationInput {
  /** Recipient user id. */
  userId: string;
  kind: NotificationKind;
  channel?: NotificationChannelName;
  /** Natural key for idempotency (e.g. `appointment:<uuid>:reminder_24h`). */
  dedupeKey: string;
  /** Typed payload the dispatcher turns into copy. */
  payload: Prisma.InputJsonObject;
  /** When the dispatcher may first attempt delivery. */
  scheduledAt?: Date;
}

/**
 * Enqueues a notification into the transactional outbox. Must be called
 * with the caller's transaction client so the outbox row commits with the
 * business write. Idempotent on `dedupeKey` —  a repeated enqueue is a
 * no-op, not an error.
 */
export async function enqueue(db: Prisma.TransactionClient, input: EnqueueNotificationInput) {
  return notificationsRepo.enqueue(db, {
    userId: input.userId,
    kind: input.kind,
    channel: input.channel ?? 'email',
    dedupeKey: input.dedupeKey,
    payload: input.payload,
    scheduledAt: input.scheduledAt ?? new Date(),
  });
}

/**
 * Returns true if the user has opted into this notification kind.
 * Preferences don't exist yet (Phase 6) — the no-op default is "send", so
 * the absence of a preference row is treated as opted-in. This keeps the
 * triggers working today and lets the preferences feature layer on later
 * without a second pass through every call-site.
 */
export async function isEnabled(
  db: Prisma.TransactionClient | typeof prisma,
  userId: string,
  kind: NotificationKind,
  channel: NotificationChannelName = 'email',
): Promise<boolean> {
  const pref = await notificationsRepo.findPreference(db, userId, kind, channel);
  if (!pref) return true; // no-pref default = opted in
  return pref.enabled;
}

// notifications services — the only exported surface other modules may
// call. Other modules must only import from here, never from
// repositories/ directly. See AGENTS.md "Non-negotiable rules".
//
// Provider-agnostic by design (ARCHITECTURE.md §1.5 / §2, PRD OQ / issue
// #17): outbound delivery goes through a `NotificationChannel` interface,
// and the default implementation is a console adapter.

export interface NotificationMessage {
  /** Destination address — an email for now (the only channel interface we need). */
  to: string;
  subject: string;
  body: string;
}

export interface NotificationChannel {
  send(message: NotificationMessage): Promise<void>;
}

/** Dev/default adapter. Writes the message to stdout instead of sending
 * it anywhere — the only way to read a reset link in local dev until the
 * decided provider adapter is wired in. Never logs a password, only the
 * single-use link (whose token is useless once used/expired). */
export const consoleNotificationChannel: NotificationChannel = {
  async send(message: NotificationMessage) {
    // eslint-disable-next-line no-console
    console.log(`[notifications] → ${message.to}\n${message.subject}\n${message.body}`);
  },
};

let channel: NotificationChannel = consoleNotificationChannel;

/** Swap the delivery adapter (real provider in prod, a spy in tests).
 * Returns the previous channel so callers can restore it. */
export function setNotificationChannel(next: NotificationChannel): NotificationChannel {
  const previous = channel;
  channel = next;
  return previous;
}

export async function send(message: NotificationMessage): Promise<void> {
  await channel.send(message);
}

/** Single-use, expiring reset link. The raw token is passed through to
 * the channel and never stored — only its hash is (auth module's
 * repository). */
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
