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
  // Upsert on the natural key so a repeated enqueue is a no-op.
  return db.notification.upsert({
    where: { dedupeKey: input.dedupeKey },
    create: {
      userId: input.userId,
      kind: input.kind,
      channel: input.channel,
      dedupeKey: input.dedupeKey,
      payload: input.payload,
      scheduledAt: input.scheduledAt,
      status: 'pending',
    },
    update: {},
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
