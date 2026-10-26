import { HttpError } from '../../../http-error';
import * as availabilityRepo from '../repositories';
import * as doctorsService from '../../doctors/services';
import { buildSlotRanges } from '../slot-generation';

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
  const existing = await availabilityRepo.findExistingSlotRanges(doctorProfileId, rangeStart, rangeEnd);
  const existingStarts = existing.map((slot) => slot.startTime.getTime());
  const rows = buildSlotRanges(input, existingStarts);

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
  await doctorsService.assertOwnsDoctorProfile(userId, doctorProfileId);
}
