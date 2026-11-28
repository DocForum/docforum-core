import { HttpError } from '../../../http-error';
import { config } from '../../../config';
import * as availabilityRepo from '../repositories';
import * as doctorsService from '../../doctors/services';
import { buildSlotRanges } from '../slot-generation';
import { excludeClosedSlots } from '../closure-periods';
import { validateSlotGenerationDate } from '../validation';
import { findApplicableClosureWindows } from './closures';

// The closure-calendar service (issue #131) lives in ./closures; re-exported
// here so callers keep importing one module service surface.
export * from './closures';

export function isOverlapOrUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || !error) return false;
  const e = error as Record<string, unknown>;
  if (e.code === 'P2002') return true;
  if (typeof e.message === 'string' && /exclusion|23P01|AvailabilitySlot_doctor_no_overlap_excl/.test(e.message)) {
    return true;
  }
  return false;
}

export async function listOpenSlots(
  doctorProfileId: string,
  query?: { from?: string; to?: string },
  now = new Date(),
) {
  // Ensure the doctor is active (not deactivated or deleted).
  // A non-existent doctor profile returns an empty list (200) rather than
  // 404, preserving the original public-listing behaviour used by the
  // access-control matrix test with placeholder ids.
  const profile = await doctorsService.getDoctorProfileById(doctorProfileId).catch((err) => {
    // Only swallow 404 (not-found) errors so non-existent doctor profiles
    // return an empty list (200) instead of 404. Let other errors propagate.
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  });
  if (profile) {
    if (profile.user.deactivatedAt || profile.user.deletedAt) {
      throw new HttpError('DOCTOR_NOT_AVAILABLE', 'Doctor is not available for booking.');
    }
  }

  let fromDate = query?.from ? new Date(query.from) : now;
  // from in the past is clamped to now (issue #289)
  if (fromDate < now) {
    fromDate = now;
  }

  let toDate: Date;
  if (query?.to) {
    toDate = new Date(query.to);
  } else {
    // Default to the next 14 days
    toDate = new Date(fromDate.getTime() + config.availability.slotsDefaultRangeDays * 24 * 60 * 60 * 1_000);
  }

  if (fromDate > toDate) {
    throw new HttpError('INVALID_DATE_RANGE', 'from must be before or equal to to.');
  }

  const maxSpanMs = config.availability.slotsMaxRangeDays * 24 * 60 * 60 * 1_000;
  if (toDate.getTime() - fromDate.getTime() > maxSpanMs) {
    throw new HttpError(
      'DATE_RANGE_TOO_LARGE',
      `Date range cannot exceed ${config.availability.slotsMaxRangeDays} days.`);
  }

  const isVerified = await doctorsService.isDoctorVerified(doctorProfileId);
  if (!isVerified) return [];

  // A closure removes the slots it covers when it is created, so this filter
  // is belt-and-braces: it also hides a slot that was released after the
  // closure existed (a cancelled booking hands its slot back to the
  // calendar). Booking by slot id is deliberately unchanged — the closure
  // sweep owns the calendar, and the booking hot path stays one conditional
  // UPDATE (hard rule 2). See ARCHITECTURE.md §4.2.
  const [slots, windows] = await Promise.all([
    availabilityRepo.findOpenSlots(doctorProfileId, fromDate, toDate),
    findApplicableClosureWindows(fromDate, toDate),
  ]);
  return excludeClosedSlots(slots, windows);
}

export interface GenerateSlotsInput {
  doctorProfileId: string;
  /** ISO date, e.g. "2026-10-19" — single day only, no recurrence
   * (ARCHITECTURE.md §6.3.6 overengineering guardrail: fixed-length slot
   * generation only, no recurrence/buffer engine). */
  date: string;
  /** IANA time zone identifier, e.g. "Europe/London", "America/New_York"
   *   The doctor's local wall-clock hours are interpreted in this zone.
   *   If omitted, defaults to UTC (backward-compatible). */
  timeZone?: string;
  startHour: number; // 0-23, local wall-clock
  endHour: number; // 0-23, local wall-clock, exclusive
  slotLengthMinutes: number;
}

export async function generateSlots(input: GenerateSlotsInput) {
  const { doctorProfileId, timeZone = 'UTC', date } = input;
  validateSlotGenerationDate(date, timeZone);

  // Today is allowed but slots already in the past today should be skipped (issue #288).
  const inputWithCutoff = {
    ...input,
    timeZone,
    skipBefore: new Date(),
  };

  let proposedSlots: ReturnType<typeof buildSlotRanges>;
  try {
    proposedSlots = buildSlotRanges(inputWithCutoff);
  } catch (error) {
    throw new HttpError('INVALID_SLOT_GENERATION', error instanceof Error ? error.message : 'Invalid slot-generation input.');
  }
  if (proposedSlots.length === 0) return { created: 0, skippedOverlapping: 0, skippedClosed: 0, skipped: 0 };

  // Phase 2, issue #131: a closure removes slots at the source, so generation
  // never creates one inside a closed period in the first place.
  const closureWindows = await findApplicableClosureWindows(
    proposedSlots[0].startTime,
    proposedSlots[proposedSlots.length - 1].endTime,
  );
  const openSlots = excludeClosedSlots(proposedSlots, closureWindows);
  const skippedClosed = proposedSlots.length - openSlots.length;
  if (openSlots.length === 0) return { created: 0, skippedOverlapping: 0, skippedClosed, skipped: skippedClosed };

  const existing = await availabilityRepo.findExistingSlotRanges(
    doctorProfileId,
    openSlots[0].startTime,
    openSlots[openSlots.length - 1].endTime,
  );
  const rows = openSlots.filter(
    (slot) => !existing.some((row) => slot.startTime < row.endTime && slot.endTime > row.startTime),
  );

  const skippedOverlapping = openSlots.length - rows.length;
  if (rows.length === 0) {
    return { created: 0, skippedOverlapping, skippedClosed, skipped: skippedOverlapping + skippedClosed };
  }

  try {
    const result = await availabilityRepo.createSlots(rows);
    return { created: result.count, skippedOverlapping, skippedClosed, skipped: skippedOverlapping + skippedClosed };
  } catch (error) {
    if (isOverlapOrUniqueViolation(error)) {
      throw new HttpError('SLOT_OVERLAP', 'Slot overlaps with an existing slot.');
    }
    throw error;
  }
}

/** Re-exported for appointments/services — the only cross-module entry
 * points into this module's booking-concurrency primitive, slot reads and
 * slot release. Never import availability/repositories from another
 * module directly. */
export { claimOpenSlot, closeOpenSlotsInRange, findSlotById as getSlot, releaseBookedSlotIfFuture } from '../repositories';

/** Batch slot-time lookup for other modules (patient data export, issue
 * #40). Times only — no status or doctor internals. */
export async function getSlotTimesByIds(slotIds: string[]): Promise<Map<string, { startTime: Date; endTime: Date }>> {
  if (slotIds.length === 0) return new Map();
  const rows = await availabilityRepo.findSlotTimesByIds([...new Set(slotIds)]);
  return new Map(rows.map((row) => [row.id, { startTime: row.startTime, endTime: row.endTime }]));
}

export async function assertCanGenerateFor(userId: string, doctorProfileId: string) {
  return doctorsService.assertOwnsDoctorProfile(userId, doctorProfileId);
}

export function getNextAvailableSlots(doctorProfileIds: string[], now = new Date()): Promise<Map<string, Date>> {
  return availabilityRepo.findNextAvailableSlotTimes(doctorProfileIds, now);
}

export function getDoctorIdsWithAvailableSlotsBefore(before: Date, now = new Date()): Promise<string[]> {
  return availabilityRepo.findDoctorProfileIdsWithAvailableSlotsBefore(before, now);
}

