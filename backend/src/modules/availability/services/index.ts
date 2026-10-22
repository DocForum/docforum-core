import { HttpError } from '../../../http-error';
import * as availabilityRepo from '../repositories';
import * as doctorsService from '../../doctors/services';
import { prisma } from '../../../db/prisma-client';
import { buildSlotRanges, isSlotClosed } from '../slot-generation';

export function listOpenSlots(doctorProfileId: string) {
  return availabilityRepo.findOpenSlots(doctorProfileId);
}

export interface GenerateSlotsInput {
  doctorProfileId: string;
  /** ISO date, e.g. "2026-09-20" — single day only, no recurrence
   * (ARCHITECTURE.md §6.3.6 overengineering guardrail: fixed-length slot
   * generation only, no recurrence/buffer engine). */
  date: string;
  startHour: number; // 0-23, UTC
  endHour: number; // 0-23, UTC, exclusive
  slotLengthMinutes: number;
}

export async function generateSlots(input: GenerateSlotsInput) {
  const { doctorProfileId, date, startHour, endHour } = input;
  try {
    buildSlotRanges(input);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid slot-generation input.');
  }
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const rangeStart = new Date(dayStart.getTime() + startHour * 60 * 60 * 1_000);
  const rangeEnd = new Date(dayStart.getTime() + endHour * 60 * 60 * 1_000);

  // Resolve the doctor's facility so platform-wide and facility-scoped
  // closures both apply.
  const doctor = await prisma.doctorProfile.findUnique({
    where: { id: doctorProfileId },
    select: { facilityId: true },
  });
  if (!doctor) throw new HttpError(404, 'Doctor profile not found.');

  const closures = await availabilityRepo.findClosuresOverlapping(doctor.facilityId ?? null, rangeStart, rangeEnd);
  const closureIntervals = closures.map((c) => ({ startDate: c.startDate, endDate: c.endDate }));

  const existing = await availabilityRepo.findExistingSlotRanges(doctorProfileId, rangeStart, rangeEnd);
  const existingStarts = existing.map((slot) => slot.startTime.getTime());
  const rows = buildSlotRanges(input, existingStarts).filter(
    (row) => !isSlotClosed(row.startTime, row.endTime, closureIntervals),
  );

  if (rows.length === 0) return { created: 0, skippedClosure: closures.length > 0 };

  const result = await availabilityRepo.createSlots(rows);
  return { created: result.count, skippedClosure: closures.length > 0 };
}

/** Re-exported for appointments/services — the only cross-module entry
 * points into this module's booking-concurrency primitive, slot reads and
 * slot release. Never import availability/repositories from another
 * module directly. */
export { claimOpenSlot, findSlotById as getSlot, releaseBookedSlotIfFuture } from '../repositories';

/** Batch slot-time lookup for other modules (patient data export, issue
 * #40). Times only — no status or doctor internals. */
export async function getSlotTimesByIds(
  slotIds: string[],
): Promise<Map<string, { startTime: Date; endTime: Date }>> {
  if (slotIds.length === 0) return new Map();
  const rows = await availabilityRepo.findSlotTimesByIds([...new Set(slotIds)]);
  return new Map(rows.map((row) => [row.id, { startTime: row.startTime, endTime: row.endTime }]));
}

export async function assertCanGenerateFor(userId: string, doctorProfileId: string) {
  await doctorsService.assertOwnsDoctorProfile(userId, doctorProfileId);
}

// --- Closure calendar ---

export interface ClosureInput {
  facilityId?: string | null;
  // ISO date (YYYY-MM-DD). Interpreted as UTC day boundaries for
  // all-day closures (time-zone correctness: the day starts at 00:00 UTC
  // and ends at 00:00 UTC of the day after endDate).
  startDate: string;
  endDate: string;
  reason: string;
}

function parseDayUtc(value: string, field: string): Date {
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${field} must be a valid ISO date.`);
  }
  return d;
}

export function listClosures(facilityId?: string | null) {
  return availabilityRepo.listClosures(facilityId ?? null);
}

export async function createClosure(input: ClosureInput, createdById: string | null) {
  const startDate = parseDayUtc(input.startDate, 'startDate');
  // endDate is inclusive as a calendar day; store the exclusive boundary
  // at the start of the next day.
  const endDay = parseDayUtc(input.endDate, 'endDate');
  const endDate = new Date(endDay.getTime() + 24 * 60 * 60 * 1_000);
  if (endDate <= startDate) {
    throw new HttpError(400, 'endDate must be on or after startDate.');
  }
  const facilityId = input.facilityId ?? null;

  const closure = await availabilityRepo.createClosure({
    facilityId,
    startDate,
    endDate,
    reason: input.reason,
    createdById,
  });

  // Apply to already-open slots. Booked slots are never auto-cancelled;
  // they are reported for manual handling.
  const affected = await applyClosureToSlots(closure.id, facilityId, startDate, endDate);
  return { closure, affected };
}

export async function updateClosure(id: string, input: ClosureInput) {
  const existing = await availabilityRepo.findClosureById(id);
  if (!existing) throw new HttpError(404, 'Closure period not found.');
  const startDate = parseDayUtc(input.startDate, 'startDate');
  const endDay = parseDayUtc(input.endDate, 'endDate');
  const endDate = new Date(endDay.getTime() + 24 * 60 * 60 * 1_000);
  if (endDate <= startDate) {
    throw new HttpError(400, 'endDate must be on or after startDate.');
  }
  const facilityId = input.facilityId ?? null;
  const closure = await availabilityRepo.updateClosure(id, {
    facilityId,
    startDate,
    endDate,
    reason: input.reason,
  });
  const affected = await applyClosureToSlots(closure.id, facilityId, startDate, endDate);
  return { closure, affected };
}

export async function deleteClosure(id: string) {
  const existing = await availabilityRepo.findClosureById(id);
  if (!existing) throw new HttpError(404, 'Closure period not found.');
  await availabilityRepo.deleteClosure(id);
  return { deleted: true };
}

/**
 * Conditional deletion of open slots in the closure range for every
 * affected doctor. Booked slots are collected and reported, never touched.
 */
async function applyClosureToSlots(
  closureId: string,
  facilityId: string | null,
  startDate: Date,
  endDate: Date,
): Promise<{
  closureId: string;
  deletedOpenSlots: number;
  affectedBookings: { slotId: string; doctorProfileId: string; startTime: Date; endTime: Date }[];
}> {
  const doctors = await availabilityRepo.findDoctorProfilesByFacility(facilityId);
  const affectedBookings: { slotId: string; doctorProfileId: string; startTime: Date; endTime: Date }[] = [];
  let deletedOpenSlots = 0;

  await prisma.$transaction(async (tx) => {
    for (const doctor of doctors) {
      // Conditional delete: only status = 'open' rows are removed.
      deletedOpenSlots += await availabilityRepo.deleteOpenSlotsInRange(
        tx,
        doctor.id,
        startDate,
        endDate,
      );
      const booked = await availabilityRepo.findBookedSlotsInRange(
        tx,
        doctor.id,
        startDate,
        endDate,
      );
      for (const slot of booked) {
        affectedBookings.push({
          slotId: slot.id,
          doctorProfileId: doctor.id,
          startTime: slot.startTime,
          endTime: slot.endTime,
        });
      }
    }
  });

  return { closureId, deletedOpenSlots, affectedBookings };
}
