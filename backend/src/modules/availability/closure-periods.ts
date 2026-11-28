// Pure all-day closure-window maths (Phase 2, issue #131).
//
// A ClosurePeriod stores an INCLUSIVE range of calendar days plus the IANA
// zone those days are read in. Everything the scheduling code compares is a
// UTC instant, so a closure has to be converted exactly once: `startDate`
// 00:00 in the closure's zone → the day after `endDate` 00:00 in that zone
// (half-open, so the last day is included and no slot at midnight is lost).
//
// Doing the conversion through `fromZonedTime` is what makes this correct
// across DST rather than assuming a day is 24 hours: a zone that springs
// forward on the closure's last day makes that day 23 hours long.
import { fromZonedTime } from 'date-fns-tz';

export interface ClosureDateRange {
  startDate: Date | string;
  endDate: Date | string;
  timeZone: string;
}

export interface UtcWindow {
  start: Date;
  end: Date;
}

export interface SlotLike {
  startTime: Date;
  endTime: Date;
}

/** `YYYY-MM-DD` for a stored calendar date. Prisma reads a `DATE` column as
 * UTC midnight, so the UTC date part is the calendar date that was written. */
export function calendarDateString(value: Date | string): string {
  if (typeof value === 'string') {
    const datePart = value.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
      throw new Error(`Not a calendar date: ${value}`);
    }
    return datePart;
  }
  return value.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/**
 * The half-open UTC instant window `[start, end)` covered by an all-day
 * closure. `start` is midnight of `startDate` in `timeZone`; `end` is
 * midnight after `endDate` in the same zone, so `endDate` itself is inside
 * the window.
 */
export function closureWindow(range: ClosureDateRange): UtcWindow {
  const startDate = calendarDateString(range.startDate);
  const endExclusive = addDays(calendarDateString(range.endDate), 1);
  return {
    start: fromZonedTime(`${startDate}T00:00:00`, range.timeZone),
    end: fromZonedTime(`${endExclusive}T00:00:00`, range.timeZone),
  };
}

/** Whether two half-open ranges share any instant. */
export function windowsOverlap(a: UtcWindow, b: UtcWindow): boolean {
  return a.start < b.end && a.end > b.start;
}

/** Whether a slot overlaps any closure window. */
export function isSlotClosed(slot: SlotLike, windows: readonly UtcWindow[]): boolean {
  const slotWindow = { start: slot.startTime, end: slot.endTime };
  return windows.some((window) => windowsOverlap(slotWindow, window));
}

/** Drops the slots that fall inside a closure. */
export function excludeClosedSlots<T extends SlotLike>(slots: readonly T[], windows: readonly UtcWindow[]): T[] {
  if (windows.length === 0) return [...slots];
  return slots.filter((slot) => !isSlotClosed(slot, windows));
}
