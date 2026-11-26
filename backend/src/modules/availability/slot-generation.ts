import { fromZonedTime } from 'date-fns-tz';

export interface SlotGenerationInput {
  doctorProfileId: string;
  date: string;
  startHour: number;
  endHour: number;
  slotLengthMinutes: number;
  timeZone?: string;
  /**
   * When provided, any slot whose startTime is on or before this cutoff is skipped.
   * Used when generating slots for today to prevent adding slots that have already passed.
   */
  skipBefore?: Date;
}

export interface GeneratedSlotRange {
  doctorProfileId: string;
  startTime: Date;
  endTime: Date;
}

export type ExistingSlot = number | { startTime: Date | number; endTime?: Date | number };

/**
 * Pure slot construction, shared by the service and property tests.
 *
 * Remainder behavior (issue #288):
 * Slots are stepped at `slotLengthMinutes * 60_000` ms intervals from rangeStart.
 * Any partial trailing remainder at the end of the window that cannot fit a full
 * `slotLengthMinutes` slot is omitted (loop condition `start + stepMs <= rangeEnd`).
 */
export function buildSlotRanges(
  input: SlotGenerationInput,
  existingSlots: readonly ExistingSlot[] = [],
): GeneratedSlotRange[] {
  const { doctorProfileId, date, startHour, endHour, slotLengthMinutes, timeZone = 'UTC', skipBefore } = input;
  if (!Number.isInteger(slotLengthMinutes) || slotLengthMinutes <= 0) {
    throw new Error('slotLengthMinutes must be a positive integer.');
  }
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)
    || startHour < 0 || endHour > 24 || startHour >= endHour) {
    throw new Error('startHour must be before endHour, both within 0-24.');
  }

  const dateStart = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(dateStart.getTime()) || dateStart.toISOString().slice(0, 10) !== date) {
    throw new Error('date must be a valid ISO date.');
  }

  const localDateTime = (hour: number) => {
    const localDate = new Date(dateStart.getTime() + hour * 60 * 60 * 1_000);
    const datePart = localDate.toISOString().slice(0, 10);
    const hourPart = String(localDate.getUTCHours()).padStart(2, '0');
    return `${datePart}T${hourPart}:00:00`;
  };
  const rangeStart = fromZonedTime(localDateTime(startHour), timeZone).getTime();
  const rangeEnd = fromZonedTime(localDateTime(endHour), timeZone).getTime();
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeStart >= rangeEnd) {
    throw new Error('date and timeZone must produce a valid slot range.');
  }
  const existingIntervals: { start: number; end: number }[] = [];
  const exactStarts = new Set<number>();
  for (const item of existingSlots) {
    if (typeof item === 'number') {
      exactStarts.add(item);
    } else {
      const start = item.startTime instanceof Date ? item.startTime.getTime() : item.startTime;
      const end = item.endTime instanceof Date ? item.endTime.getTime() : (item.endTime ?? start + 1);
      existingIntervals.push({ start, end });
    }
  }

  const stepMs = slotLengthMinutes * 60 * 1_000;
  const skipBeforeMs = skipBefore ? skipBefore.getTime() : -Infinity;
  const slots: GeneratedSlotRange[] = [];

  for (let start = rangeStart; start + stepMs <= rangeEnd; start += stepMs) {
    if (start <= skipBeforeMs) continue;
    const end = start + stepMs;
    if (exactStarts.has(start)) continue;
    const overlaps = existingIntervals.some((interval) => start < interval.end && end > interval.start);
    if (overlaps) continue;
    slots.push({ doctorProfileId, startTime: new Date(start), endTime: new Date(end) });
  }
  return slots;
}
