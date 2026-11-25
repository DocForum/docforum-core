import { HttpError } from '../../../http-error';
import { config } from '../../../config';
import * as availabilityRepo from '../repositories';
import * as doctorsService from '../../doctors/services';
import { buildSlotRanges } from '../slot-generation';
import { validateSlotGenerationDate } from '../validation';

export async function listOpenSlots(
  doctorProfileId: string,
  query?: { from?: string; to?: string },
  now = new Date(),
) {
  // Ensure the doctor is active (not deactivated or deleted).
  // A non-existent doctor profile returns an empty list (200) rather than
  // 404, preserving the original public-listing behaviour used by the
  // access-control matrix test with placeholder ids.
  const profile = await doctorsService.getDoctorProfileById(doctorProfileId);
  if (profile) {
    if (profile.user.deactivatedAt || profile.user.deletedAt) {
      throw new HttpError(409, 'Doctor is not available for booking.');
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
    throw new HttpError(400, 'from must be before or equal to to.', 'INVALID_DATE_RANGE');
  }

  const maxSpanMs = config.availability.slotsMaxRangeDays * 24 * 60 * 60 * 1_000;
  if (toDate.getTime() - fromDate.getTime() > maxSpanMs) {
    throw new HttpError(
      400,
      `Date range cannot exceed ${config.availability.slotsMaxRangeDays} days.`,
      'DATE_RANGE_TOO_LARGE',
    );
  }

  return availabilityRepo.findOpenSlots(doctorProfileId, fromDate, toDate);
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
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid slot-generation input.');
  }
  if (proposedSlots.length === 0) return { created: 0 };

  const existing = await availabilityRepo.findExistingSlotRanges(
    doctorProfileId,
    proposedSlots[0].startTime,
    proposedSlots[proposedSlots.length - 1].endTime,
  );
  const existingStarts = existing.map((slot) => slot.startTime.getTime());
  let rows: ReturnType<typeof buildSlotRanges>;
  try {
    rows = buildSlotRanges(inputWithCutoff, existingStarts);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid slot-generation input.');
  }

  if (rows.length === 0) return { created: 0 };

  const result = await availabilityRepo.createSlots(rows);
  return { created: result.count };
}

/** Re-exported for appointments/services — the only cross-module entry
 * points into this module's booking-concurrency primitive, slot reads and
 * slot release. Never import availability/repositories from another
 * module directly. */
export { claimOpenSlot, findSlotById as getSlot, releaseBookedSlotIfFuture } from '../repositories';

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
