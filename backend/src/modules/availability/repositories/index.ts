import { prisma } from '../../../db/prisma-client';
import type { Prisma } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function findOpenSlots(doctorProfileId: string, from: Date, to: Date) {
  return prisma.availabilitySlot.findMany({
    where: {
      doctorProfileId,
      status: 'open',
      startTime: { gte: from, lte: to },
    },
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
    where: { doctorProfileId, startTime: { lt: endTime }, endTime: { gt: startTime } },
    select: { startTime: true, endTime: true },
  });
}

export function createSlots(rows: { doctorProfileId: string; startTime: Date; endTime: Date }[]) {
  return prisma.availabilitySlot.createMany({ data: rows });
}

export async function findNextAvailableSlotTimes(
  doctorProfileIds: string[],
  now = new Date(),
): Promise<Map<string, Date>> {
  if (doctorProfileIds.length === 0) return new Map();
  const slots = await prisma.availabilitySlot.findMany({
    where: {
      doctorProfileId: { in: doctorProfileIds },
      status: 'open',
      startTime: { gte: now },
      doctorProfile: { user: { deactivatedAt: null, deletedAt: null } },
    },
    orderBy: { startTime: 'asc' },
    select: { doctorProfileId: true, startTime: true },
  });
  const nextByDoctorId = new Map<string, Date>();
  for (const slot of slots) {
    if (!nextByDoctorId.has(slot.doctorProfileId)) {
      nextByDoctorId.set(slot.doctorProfileId, slot.startTime);
    }
  }
  return nextByDoctorId;
}

export async function findDoctorProfileIdsWithAvailableSlotsBefore(
  before: Date,
  now = new Date(),
): Promise<string[]> {
  const slots = await prisma.availabilitySlot.findMany({
    where: {
      status: 'open',
      startTime: {
        gte: now,
        lt: before,
      },
      doctorProfile: { user: { deactivatedAt: null, deletedAt: null } },
    },
    select: { doctorProfileId: true },
    distinct: ['doctorProfileId'],
  });
  return slots.map((s) => s.doctorProfileId);
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
 * Issue #285: conditional on `startTime > now` so a slot whose time has
 * passed can never be claimed by any path at the DB level.
 *
 * Accepts a transaction client so callers (appointments/services) can run
 * this as one step inside a larger transaction that also creates the
 * Appointment row — see backend/tests/integration/booking.test.ts for the
 * concurrency proof.
 */
export async function claimOpenSlot(db: DbClient, slotId: string, now: Date = new Date()): Promise<boolean> {
  const result = await db.availabilitySlot.updateMany({
    where: { id: slotId, status: 'open', startTime: { gt: now } },
    data: { status: 'booked' },
  });
  return result.count === 1;
}

/**
 * Inverse of claimOpenSlot, used when a FUTURE booked slot is freed by a
 * cancellation (direct booking or the referral cascade). Conditional on
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

// --- Closure calendar (Phase 2, issue #131) --------------------------------

export type ClosureScopeName = 'platform' | 'facility';

export interface ClosurePeriodInput {
  scope: ClosureScopeName;
  facilityProfileId: string | null;
  startDate: Date;
  endDate: Date;
  timeZone: string;
  reason: string;
}

export function createClosurePeriod(db: DbClient, data: ClosurePeriodInput) {
  return db.closurePeriod.create({ data });
}

export function findClosureById(db: DbClient, id: string) {
  return db.closurePeriod.findUnique({ where: { id } });
}

/**
 * Closures whose inclusive calendar-day range overlaps `[fromDate, toDate]`.
 * Callers widen the requested boundary by a day: a closure is stored as
 * calendar dates in its own `timeZone`, so a slot near midnight UTC can belong
 * to the neighbouring closure date. The exact filtering is done on the
 * converted instant windows (`closure-periods.ts`), not on this query.
 */
export function findClosuresOverlapping(fromDate: Date, toDate: Date) {
  return prisma.closurePeriod.findMany({
    where: { startDate: { lte: toDate }, endDate: { gte: fromDate } },
    orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
  });
}

/** Lists closures, optionally bounded by calendar dates (inclusive). */
export function findClosures(
  filters: { fromDate?: Date; toDate?: Date; scope?: ClosureScopeName },
) {
  return prisma.closurePeriod.findMany({
    where: {
      ...(filters.fromDate ? { endDate: { gte: filters.fromDate } } : {}),
      ...(filters.toDate ? { startDate: { lte: filters.toDate } } : {}),
      ...(filters.scope ? { scope: filters.scope } : {}),
    },
    orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
  });
}

/**
 * ONE conditional UPDATE that also moves `version` (hard rule 7). Zero rows
 * means someone else changed the row since the caller read it — the service
 * turns that into `412`.
 */
export function updateClosureIfVersion(
  db: DbClient,
  id: string,
  expectedVersion: number,
  data: { startDate: Date; endDate: Date; timeZone: string; reason?: string },
) {
  return db.closurePeriod.updateManyAndReturn({
    where: { id, version: expectedVersion },
    data: { ...data, version: { increment: 1 } },
  });
}

export function deleteClosurePeriod(db: DbClient, id: string) {
  return db.closurePeriod.deleteMany({ where: { id } });
}

/**
 * Conditionally removes the still-open slots that overlap `[from, end)`.
 *
 * The conditions are the point: `status = 'open'` and no appointment means a
 * slot booked (or held) at the same instant is left untouched, and the whole
 * thing is one DELETE rather than a read-then-write loop. Booked appointments
 * are reported by the service, never cancelled here.
 */
export function deleteOpenSlotsInWindow(db: DbClient, from: Date, end: Date) {
  return db.availabilitySlot.deleteMany({
    where: {
      status: 'open',
      startTime: { lt: end },
      endTime: { gt: from },
      appointment: { is: null },
    },
  });
}

/**
 * Closes (deletes) a doctor's still-open slots that start in [from, end)
 * — the doctor-cancels-a-day action (issue #338). Conditional on
 * `status = 'open'` with no appointment attached, so a slot booked or held
 * concurrently is never removed from under its booking. Returns how many
 * slots were closed.
 */
export async function closeOpenSlotsInRange(doctorProfileId: string, from: Date, end: Date): Promise<number> {
  const result = await prisma.availabilitySlot.deleteMany({
    where: {
      doctorProfileId,
      status: 'open',
      startTime: { gte: from, lt: end },
      appointment: { is: null },
    },
  });
  return result.count;
}
