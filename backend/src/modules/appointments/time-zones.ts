import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { HttpError } from '../../http-error';
import { config } from '../../config';
import { isValidIanaTimeZone } from '../../utils/time-zones';

export function assertValidTimeZone(timeZone: string): void {
  if (!isValidIanaTimeZone(timeZone)) {
    throw new HttpError(400, `Invalid time zone: ${timeZone}`, 'INVALID_TIME_ZONE');
  }
}

/**
 * Computes the start and end of the local calendar day for `timeZone` (issue #290).
 * Handles DST transitions naturally (e.g. 23h spring forward, 25h fall back).
 */
export function getCalendarDayBounds(timeZone: string, now: Date = new Date()): { start: Date; end: Date } {
  assertValidTimeZone(timeZone);

  const todayStr = formatInTimeZone(now, timeZone, 'yyyy-MM-dd');
  const [y, m, d] = todayStr.split('-').map(Number);
  const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
  const nextDayStr = nextDay.toISOString().slice(0, 10);

  const start = fromZonedTime(`${todayStr}T00:00:00`, timeZone);
  const end = fromZonedTime(`${nextDayStr}T00:00:00`, timeZone);

  return { start, end };
}

/**
 * Parses and bounds arbitrary date ranges in the doctor's time zone (issue #291).
 */
export function parseScheduleDateRange(
  timeZone: string,
  from?: string,
  to?: string,
  now: Date = new Date(),
): { start: Date; end: Date } {
  assertValidTimeZone(timeZone);

  let start: Date;
  if (from) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      start = fromZonedTime(`${from}T00:00:00`, timeZone);
    } else {
      start = new Date(from);
      if (Number.isNaN(start.getTime())) {
        throw new HttpError(400, 'Invalid from date format.', 'INVALID_DATE');
      }
    }
  } else {
    const todayBounds = getCalendarDayBounds(timeZone, now);
    start = todayBounds.start;
  }

  let end: Date;
  if (to) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      // End of that day (midnight of next day)
      const [y, m, d] = to.split('-').map(Number);
      const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
      const nextDayStr = nextDay.toISOString().slice(0, 10);
      end = fromZonedTime(`${nextDayStr}T00:00:00`, timeZone);
    } else {
      end = new Date(to);
      if (Number.isNaN(end.getTime())) {
        throw new HttpError(400, 'Invalid to date format.', 'INVALID_DATE');
      }
    }
  } else {
    // Default to 14 days after start
    end = new Date(start.getTime() + config.availability.slotsDefaultRangeDays * 24 * 60 * 60 * 1_000);
  }

  if (start > end) {
    throw new HttpError(400, 'from must be before or equal to to.', 'INVALID_DATE_RANGE');
  }

  const maxSpanMs = config.availability.slotsMaxRangeDays * 24 * 60 * 60 * 1_000;
  if (end.getTime() - start.getTime() > maxSpanMs) {
    throw new HttpError(
      400,
      `Date range cannot exceed ${config.availability.slotsMaxRangeDays} days.`,
      'DATE_RANGE_TOO_LARGE',
    );
  }

  return { start, end };
}
