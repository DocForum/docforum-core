import { HttpError } from '../../../http-error';
import * as availabilityRepo from '../repositories';
import * as doctorsService from '../../doctors/services';

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
  const { doctorProfileId, date, startHour, endHour, slotLengthMinutes } = input;

  if (slotLengthMinutes <= 0) throw new HttpError(400, 'slotLengthMinutes must be positive.');
  if (startHour < 0 || endHour > 24 || startHour >= endHour) {
    throw new HttpError(400, 'startHour must be before endHour, both within 0-24.');
  }

  const dayStart = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(dayStart.getTime())) throw new HttpError(400, 'date must be a valid ISO date.');

  const rangeStart = new Date(dayStart.getTime() + startHour * 60 * 60 * 1000);
  const rangeEnd = new Date(dayStart.getTime() + endHour * 60 * 60 * 1000);

  const existing = await availabilityRepo.findExistingSlotRanges(doctorProfileId, rangeStart, rangeEnd);
  const existingStarts = new Set(existing.map((slot) => slot.startTime.getTime()));

  const rows: { doctorProfileId: string; startTime: Date; endTime: Date }[] = [];
  const stepMs = slotLengthMinutes * 60 * 1000;
  for (let start = rangeStart.getTime(); start + stepMs <= rangeEnd.getTime(); start += stepMs) {
    if (existingStarts.has(start)) continue; // idempotent: skip slots already generated
    rows.push({ doctorProfileId, startTime: new Date(start), endTime: new Date(start + stepMs) });
  }

  if (rows.length === 0) return { created: 0 };

  const result = await availabilityRepo.createSlots(rows);
  return { created: result.count };
}

/** Re-exported for appointments/services — the only cross-module entry
 * points into this module's booking-concurrency primitive and slot reads.
 * Never import availability/repositories from another module directly. */
export { claimOpenSlot, findSlotById as getSlot } from '../repositories';

export async function assertCanGenerateFor(userId: string, doctorProfileId: string) {
  await doctorsService.assertOwnsDoctorProfile(userId, doctorProfileId);
}
