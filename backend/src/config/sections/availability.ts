import { positiveNumber } from '../helpers';

// Availability & slot generation (Phase 2, issues #288 and #289).
export const availability = {
  slotMinDurationMinutes: positiveNumber(process.env.SLOT_MIN_DURATION_MINUTES, 5),
  slotMaxDurationMinutes: positiveNumber(process.env.SLOT_MAX_DURATION_MINUTES, 240),
  slotMaxHorizonDays: positiveNumber(process.env.SLOT_MAX_HORIZON_DAYS, 365),
  slotsDefaultRangeDays: positiveNumber(process.env.SLOTS_DEFAULT_RANGE_DAYS, 14),
  slotsMaxRangeDays: positiveNumber(process.env.SLOTS_MAX_RANGE_DAYS, 31),
} as const;
