import type { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma-client';

/**
 * Data access for the notifications module. Other modules must not
 * import from here — go through services/ instead (AGENTS.md).
 */

export interface EnqueueInput {
  userId: string;
  kind: string;
  channel: string;
  dedupeKey: string;
  payload: Prisma.InputJsonObject;
  scheduledAt: Date;
}

export async function enqueue(db: Prisma.TransactionClient, input: EnqueueInput) {
  // Idempotent enqueue: if a notification with the same dedupeKey already
  // exists, return it unchanged instead of creating a duplicate.
  const existing = await db.notification.findFirst({
    where: { dedupeKey: input.dedupeKey },
  });
  if (existing) {
    return existing;
  }
  return db.notification.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      channel: input.channel,
      dedupeKey: input.dedupeKey,
      payload: input.payload,
      scheduledAt: input.scheduledAt,
      status: 'pending',
    },
  });
}

export async function findPreference(
  db: Prisma.TransactionClient | typeof prisma,
  userId: string,
  kind: string,
  channel: string,
) {
  return db.notificationPreference.findUnique({
    where: { userId_kind_channel: { userId, kind, channel } },
  });
}
