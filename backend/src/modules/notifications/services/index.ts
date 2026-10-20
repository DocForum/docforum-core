import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';
import * as notificationsRepo from '../repositories';

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

export type NotificationChannel = 'email';

export interface EnqueueNotificationInput {
  /** Recipient user id. */
  userId: string;
  kind: NotificationKind;
  channel?: NotificationChannel;
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
  channel: NotificationChannel = 'email',
): Promise<boolean> {
  const pref = await notificationsRepo.findPreference(db, userId, kind, channel);
  if (!pref) return true; // no-pref default = opted in
  return pref.enabled;
}
