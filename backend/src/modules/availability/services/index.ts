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

  // Closure calendar (Public holidays / clinic closures). A closure that
  // overlaps the requested range blocks generation entirely.
  const closures = await availabilityRepo.findClosuresOverlapping(
    await availabilityRepo.findDoctorFacilityId(doctorProfileId),
    rangeStart,
    rangeEnd,
  );
  if (closures.length > 0) {
    throw new HttpError(409, 'Slot generation is blocked by a closure period.');
  }

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

/** Closure calendar (Phase 2). Admin-managed closures block slot
 * generation and remove open slots in range. Booked appointments are
 * reported, never auto-cancelled. */
export interface CreateClosureInput {
  /** Platform-wide when facilityId is null. */
  facilityId?: string | null;
  /** ISO date (inclusive), e.g. "2026-12-25". All-day closures are
   * interpreted in UTC for consistency with slot generation. */
  startDate: string;
  /** ISO date (inclusive). */
  endDate: string;
  reason: string;
}

export interface ClosureReport {
  closureId: string;
  affectedSlots: number;
  affectedBookings: {
    appointmentId: string;
    slotId: string;
    patientId: string;
    startTime: Date;
  }[];
}

function parseIsoDate(value: string, field: string): Date {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new HttpError(400, `${field} must be a valid ISO date.`);
  return parsed;
}

export async function createClosure(input: CreateClosureInput): Promise<ClosureReport> {
  const start = parseIsoDate(input.startDate, 'startDate');
  const end = parseIsoDate(input.endDate, 'endDate');
  if (end < start) throw new HttpError(400, 'endDate must be on or after startDate.');
  if (!input.reason || !input.reason.trim()) throw new HttpError(400, 'reason is required.');

  // Inclusive end date — extend to the start of the following day (UTC).
  const rangeStart = start;
  const rangeEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);

  const closure = await availabilityRepo.createClosurePeriod({
    facilityId: input.facilityId ?? null,
    startDate: rangeStart,
    endDate: rangeEnd,
    reason: input.reason.trim(),
  });

  // Report booked appointments before removing open slots. Booked slots
  // are never deleted or cancelled here — manual handling only.
  const affected = await availabilityRepo.findAffectedBookings({
    facilityId: closure.facilityId,
    rangeStart,
    rangeEnd,
  });

  const removed = await availabilityRepo.removeOpenSlotsInRange({
    facilityId: closure.facilityId,
    rangeStart,
    rangeEnd,
  });

  return {
    closureId: closure.id,
    affectedSlots: removed.count,
    affectedBookings: affected.map((booking) => ({
      appointmentId: booking.appointmentId,
      slotId: booking.slotId,
      patientId: booking.patientId,
      startTime: booking.startTime,
    })),
  };
}

export function listClosures(facilityId?: string | null) {
  return availabilityRepo.findClosures(facilityId ?? null);
}

export async function deleteClosure(id: string) {
  const deleted = await availabilityRepo.deleteClosurePeriod(id);
  if (deleted.count === 0) throw new HttpError(404, 'Closure not found.');
  return { deleted: deleted.count };
}

export async function isRangeClosed(facilityId: string | null, startTime: Date, endTime: Date): Promise<boolean> {
  const closures = await availabilityRepo.findClosuresOverlapping(facilityId, startTime, endTime);
  return closures.length > 0;
}
