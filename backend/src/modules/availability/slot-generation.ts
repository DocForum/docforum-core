import { fromZonedTime } from 'date-fns-tz';

export interface SlotGenerationInput {
  doctorProfileId: string;
  date: string;
  startHour: number;
  endHour: number;
  slotLengthMinutes: number;
  timeZone?: string;
}

export interface GeneratedSlotRange {
  doctorProfileId: string;
  startTime: Date;
  endTime: Date;
}

/** Pure slot construction, shared by the service and property tests. */
export function buildSlotRanges(
  input: SlotGenerationInput,
  existingStartTimes: readonly number[] = [],
): GeneratedSlotRange[] {
  const { doctorProfileId, date, startHour, endHour, slotLengthMinutes, timeZone = 'UTC' } = input;
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
  const existing = new Set(existingStartTimes);
  const stepMs = slotLengthMinutes * 60 * 1_000;
  const slots: GeneratedSlotRange[] = [];

  for (let start = rangeStart; start + stepMs <= rangeEnd; start += stepMs) {
    if (existing.has(start)) continue;
    slots.push({ doctorProfileId, startTime: new Date(start), endTime: new Date(start + stepMs) });
  }
  return slots;
}
