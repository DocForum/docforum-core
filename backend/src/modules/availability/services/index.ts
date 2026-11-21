import { HttpError } from '../../../http-error';
import * as availabilityRepo from '../repositories';
import * as doctorsService from '../../doctors/services';
import { buildSlotRanges } from '../slot-generation';

function isOverlapOrUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as Record<string, unknown>;
  if (e.code === 'P2002') return true;
  if (typeof e.message === 'string' && (e.message.includes('exclusion') || e.message.includes('23P01') || e.message.includes('AvailabilitySlot_doctor_no_overlap_excl'))) {
    return true;
  }
  return false;
}

export async function listOpenSlots(doctorProfileId: string) {
  const isVerified = await doctorsService.isDoctorVerified(doctorProfileId);
  if (!isVerified) return [];
  return availabilityRepo.findOpenSlots(doctorProfileId);
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
  const { doctorProfileId } = input;
  let proposedSlots: ReturnType<typeof buildSlotRanges>;
  try {
    proposedSlots = buildSlotRanges(input);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid slot-generation input.');
  }
  if (proposedSlots.length === 0) return { created: 0, skippedOverlapping: 0, skipped: 0 };

  const existing = await availabilityRepo.findExistingSlotRanges(
    doctorProfileId,
    proposedSlots[0].startTime,
    proposedSlots[proposedSlots.length - 1].endTime,
  );
  let rows: ReturnType<typeof buildSlotRanges>;
  try {
    rows = buildSlotRanges(input, existing);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid slot-generation input.');
  }

  const skippedOverlapping = proposedSlots.length - rows.length;
  if (rows.length === 0) return { created: 0, skippedOverlapping, skipped: skippedOverlapping };

  try {
    const result = await availabilityRepo.createSlots(rows);
    return { created: result.count, skippedOverlapping, skipped: skippedOverlapping };
  } catch (error) {
    if (isOverlapOrUniqueViolation(error)) {
      throw new HttpError(409, 'Slot overlaps with an existing slot.');
    }
    throw error;
  }
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
  await doctorsService.assertOwnsDoctorProfile(userId, doctorProfileId);
}
