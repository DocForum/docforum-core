import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function findOpenSlots(doctorProfileId: string) {
  return prisma.availabilitySlot.findMany({
    where: { doctorProfileId, status: 'open', startTime: { gte: new Date() } },
    orderBy: { startTime: 'asc' },
  });
}

export function findSlotById(db: DbClient, slotId: string) {
  return db.availabilitySlot.findUnique({ where: { id: slotId } });
}

export function findExistingSlotRanges(doctorProfileId: string, startTime: Date, endTime: Date) {
  return prisma.availabilitySlot.findMany({
    where: { doctorProfileId, startTime: { gte: startTime }, endTime: { lte: endTime } },
    select: { startTime: true, endTime: true },
  });
}

export function createSlots(rows: { doctorProfileId: string; startTime: Date; endTime: Date }[]) {
  return prisma.availabilitySlot.createMany({ data: rows });
}

/**
 * THE mechanism that prevents double-booking (ARCHITECTURE.md §5.1): a
 * single conditional UPDATE, atomic at the database level regardless of
 * how many requests race to call this for the same slotId. Postgres
 * serializes concurrent UPDATEs to the same row via row-level locking —
 * exactly one caller's WHERE clause matches `status = 'open'`; every other
 * concurrent caller's WHERE clause evaluates against the now-committed
 * `booked` row and matches zero rows.
 *
 * Accepts a transaction client so callers (appointments/services) can run
 * this as one step inside a larger transaction that also creates the
 * Appointment row — see backend/tests/integration/booking.test.ts for the
 * concurrency proof.
 */
export async function claimOpenSlot(db: DbClient, slotId: string): Promise<boolean> {
  const result = await db.availabilitySlot.updateMany({
    where: { id: slotId, status: 'open' },
    data: { status: 'booked' },
  });
  return result.count === 1;
}
