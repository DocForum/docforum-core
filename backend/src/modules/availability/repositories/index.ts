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

export function findSlotTimesByIds(slotIds: string[]) {
  return prisma.availabilitySlot.findMany({
    where: { id: { in: slotIds } },
    select: { id: true, startTime: true, endTime: true },
  });
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
 * single conditional UPDATE, atomic at the database level regardless of how
 * many requests race to call this for the same slotId. Postgres
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

/**
 * Inverse of claimOpenSlot, used when a FUTURE booked slot is freed by
 * a cancellation (direct booking or the referral cascade). Conditional on
 * both `booked` and `startTime > now` — a slot whose time has passed is
 * left alone: the visit happened (or didn't) either way, and re-opening
 * it would put unbookable time back on the calendar.
 */
export async function releaseBookedSlotIfFuture(db: DbClient, slotId: string): Promise<boolean> {
  const result = await db.availabilitySlot.updateMany({
    where: { id: slotId, status: 'booked', startTime: { gt: new Date() } },
    data: { status: 'open' },
  });
  return result.count === 1;
}

// --- Closure periods ---

export function findClosuresOverlapping(facilityId: string | null, startTime: Date, endTime: Date) {
  return prisma.closurePeriod.findMany({
    where: {
      OR: [{ facilityId: null }, ...(facilityId ? [{ facilityId }] : [])],
      startDate: { lt: endTime },
      endDate: { gt: startTime },
    },
    orderBy: { startDate: 'asc' },
  });
}

export function listClosures(facilityId?: string | null) {
  return prisma.closurePeriod.findMany({
    where: facilityId ? { OR: [{ facilityId: null }, { facilityId }] } : {},
    orderBy: { startDate: 'asc' },
  });
}

export function findClosureById(id: string) {
  return prisma.closurePeriod.findUnique({ where: { id } });
}

export function createClosure(data: {
  facilityId: string | null;
  startDate: Date;
  endDate: Date;
  reason: string;
  createdById?: string | null;
}) {
  return prisma.closurePeriod.create({ data });
}

export function updateClosure(
  id: string,
  data: Partial<{ facilityId: string | null; startDate: Date; endDate: Date; reason: string }>,
) {
  return prisma.closurePeriod.update({ where: { id }, data });
}

export function deleteClosure(id: string) {
  return prisma.closurePeriod.delete({ where: { id } });
}

/**
 * Conditional delete of open slots in a closure range. Only rows still
 * `status = 'open'` are removed; booked slots are never touched. Returns the
 * count of deleted rows so the caller can report the affected range.
 */
export async function deleteOpenSlotsInRange(db: DbClient, doctorProfileId: string, startTime: Date, endTime: Date): Promise<number> {
  const result = await db.availabilitySlot.deleteMany({
    where: {
      doctorProfileId,
      status: 'open',
      startTime: { gte: startTime, lt: endTime },
    },
  });
  return result.count;
}

export function findBookedSlotsInRange(db: DbClient, doctorProfileId: string, startTime: Date, endTime: Date) {
  return db.availabilitySlot.findMany({
    where: {
      doctorProfileId,
      status: 'booked',
      startTime: { gte: startTime, lt: endTime },
    },
    select: { id: true, startTime: true, endTime: true },
  });
}

export function findDoctorProfilesByFacility(facilityId: string | null) {
  return prisma.doctorProfile.findMany({
    where: facilityId ? { facilityId } : {},
    select: { id: true },
  });
}
