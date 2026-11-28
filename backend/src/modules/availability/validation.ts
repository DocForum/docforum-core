import { z } from 'zod';
import { formatInTimeZone } from 'date-fns-tz';
import { config } from '../../config';
import { HttpError } from '../../http-error';
import { isValidIanaTimeZone } from '../../utils/time-zones';

export function assertValidTimeZone(timeZone: string): void {
  if (!isValidIanaTimeZone(timeZone)) {
    throw new HttpError('INVALID_TIME_ZONE', `Invalid time zone: ${timeZone}`);
  }
}

export const generateSlotsSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    startHour: z.number().int().min(0, 'startHour must be at least 0').max(23, 'startHour must be at most 23'),
    endHour: z.number().int().min(1, 'endHour must be at least 1').max(24, 'endHour must be at most 24'),
    slotLengthMinutes: z
      .number()
      .int()
      .min(
        config.availability.slotMinDurationMinutes,
        `slotLengthMinutes must be at least ${config.availability.slotMinDurationMinutes}`,
      )
      .max(
        config.availability.slotMaxDurationMinutes,
        `slotLengthMinutes cannot exceed ${config.availability.slotMaxDurationMinutes}`,
      ),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.startHour >= data.endHour) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'startHour must be before endHour.',
        path: ['startHour'],
      });
      return;
    }
    const windowMinutes = (data.endHour - data.startHour) * 60;
    if (windowMinutes % data.slotLengthMinutes !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Window duration must be cleanly divisible by slotLengthMinutes.',
        path: ['slotLengthMinutes'],
      });
    }
  });

export function validateSlotGenerationDate(date: string, timeZone: string, now = new Date()): void {
  assertValidTimeZone(timeZone);

  const dateObj = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(dateObj.getTime()) || dateObj.toISOString().slice(0, 10) !== date) {
    throw new HttpError('INVALID_DATE', 'date must be a valid ISO date (YYYY-MM-DD).');
  }

  const todayInZone = formatInTimeZone(now, timeZone, 'yyyy-MM-dd');
  if (date < todayInZone) {
    throw new HttpError('SLOT_DATE_IN_PAST', 'Cannot generate slots for a date in the past.');
  }

  const [y, m, d] = todayInZone.split('-').map(Number);
  const maxDate = new Date(Date.UTC(y, m - 1, d + config.availability.slotMaxHorizonDays));
  const maxDateStr = maxDate.toISOString().slice(0, 10);
  if (date > maxDateStr) {
    throw new HttpError(
      'SLOT_DATE_BEYOND_HORIZON',
      `Date cannot be beyond ${config.availability.slotMaxHorizonDays} days in the future.`);
  }
}

export const listSlotsQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

// --- Closure calendar (Phase 2, issue #131) --------------------------------

/** A real calendar day, `YYYY-MM-DD` (rejects 2026-02-30). */
const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    // `toISOString` throws on an invalid date, so check before comparing.
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'date must be a real calendar day');

/**
 * Body for `POST /availability/admin/closures`. The range is inclusive; the
 * zone is the zone the all-day range is read in (defaults to UTC in the
 * service). Scope/facility consistency and the range size are checked in the
 * service, where the DB-backed facility lookup and the configured horizon are
 * available.
 */
export const createClosurePeriodSchema = z
  .object({
    scope: z.enum(['platform', 'facility']),
    facilityProfileId: z.string().min(1).optional(),
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    timeZone: z.string().min(1).max(64).optional(),
    reason: z.string().trim().min(1, 'reason is required').max(200),
  })
  .strict();

/** Body for `PATCH /availability/admin/closures/:closureId` — partial, at
 * least one field. The version comes from `If-Match`, not the body. */
export const updateClosurePeriodSchema = z
  .object({
    startDate: calendarDateSchema.optional(),
    endDate: calendarDateSchema.optional(),
    timeZone: z.string().min(1).max(64).optional(),
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'At least one of startDate, endDate, timeZone or reason is required.',
  });

/** Query for both closure lists. `from`/`to` bound the calendar range
 * (inclusive); the public list defaults `from` to today, the admin list does
 * not filter at all unless asked. */
export const listClosurePeriodsQuerySchema = z
  .object({
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    scope: z.enum(['platform', 'facility']).optional(),
  })
  .strict();
