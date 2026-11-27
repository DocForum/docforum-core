import { describe, expect, it } from 'vitest';
import { generateSlotsSchema, validateSlotGenerationDate } from '../../src/modules/availability/validation';
import { buildSlotRanges } from '../../src/modules/availability/slot-generation';

describe('slot generation input guard rails (issue #288)', () => {
  const validBase = {
    date: '2026-11-25',
    startHour: 9,
    endHour: 17,
    slotLengthMinutes: 30,
  };

  it('accepts valid slot generation inputs with divisible windows', () => {
    const parsed = generateSlotsSchema.parse(validBase);
    expect(parsed.slotLengthMinutes).toBe(30);
    expect(parsed.startHour).toBe(9);
    expect(parsed.endHour).toBe(17);
  });

  it('rejects slotLengthMinutes below the minimum (5 minutes)', () => {
    expect(() =>
      generateSlotsSchema.parse({
        ...validBase,
        slotLengthMinutes: 4,
      }),
    ).toThrow(/at least 5/);
  });

  it('rejects slotLengthMinutes above the maximum (240 minutes)', () => {
    expect(() =>
      generateSlotsSchema.parse({
        ...validBase,
        slotLengthMinutes: 241,
      }),
    ).toThrow(/cannot exceed 240/);
  });

  it('rejects slotLengthMinutes of 0 or negative', () => {
    expect(() =>
      generateSlotsSchema.parse({
        ...validBase,
        slotLengthMinutes: 0,
      }),
    ).toThrow();
  });

  it('rejects windows that are not cleanly divisible by slotLengthMinutes', () => {
    // 9 to 10 is 60 minutes; 45 does not divide 60
    expect(() =>
      generateSlotsSchema.parse({
        ...validBase,
        startHour: 9,
        endHour: 10,
        slotLengthMinutes: 45,
      }),
    ).toThrow('Window duration must be cleanly divisible by slotLengthMinutes.');
  });

  it('rejects startHour >= endHour', () => {
    expect(() =>
      generateSlotsSchema.parse({
        ...validBase,
        startHour: 17,
        endHour: 9,
      }),
    ).toThrow('startHour must be before endHour.');

    expect(() =>
      generateSlotsSchema.parse({
        ...validBase,
        startHour: 10,
        endHour: 10,
      }),
    ).toThrow('startHour must be before endHour.');
  });

  it('rejects invalid date format in schema', () => {
    expect(() =>
      generateSlotsSchema.parse({
        ...validBase,
        date: '25-11-2026',
      }),
    ).toThrow('date must be YYYY-MM-DD');
  });

  it('rejects dates in the past in the doctor time zone with coded 400', () => {
    const fixedNow = new Date('2026-11-20T12:00:00.000Z');
    // For Africa/Lagos (UTC+1), 2026-11-19 is in the past
    expect(() => validateSlotGenerationDate('2026-11-19', 'Africa/Lagos', fixedNow)).toThrowError(
      expect.objectContaining({
        status: 400,
        code: 'SLOT_DATE_IN_PAST',
        message: 'Cannot generate slots for a date in the past.',
      }),
    );
  });

  it('rejects dates beyond the configurable horizon with coded 400', () => {
    const fixedNow = new Date('2026-11-20T12:00:00.000Z');
    // 2 years in the future is beyond default 365-day horizon
    expect(() => validateSlotGenerationDate('2028-11-25', 'Africa/Lagos', fixedNow)).toThrowError(
      expect.objectContaining({
        status: 400,
        code: 'SLOT_DATE_BEYOND_HORIZON',
      }),
    );
  });

  it('rejects invalid calendar dates like 2026-02-30', () => {
    const fixedNow = new Date('2026-01-01T12:00:00.000Z');
    expect(() => validateSlotGenerationDate('2026-02-30', 'UTC', fixedNow)).toThrowError(
      expect.objectContaining({
        status: 400,
        code: 'INVALID_DATE',
      }),
    );
  });

  it('rejects invalid IANA time zone strings', () => {
    expect(() => validateSlotGenerationDate('2026-11-25', 'Invalid/Timezone')).toThrowError(
      expect.objectContaining({
        status: 400,
        code: 'INVALID_TIME_ZONE',
      }),
    );
  });

  it('skips slots that are already in the past when generating for today', () => {
    // Simulated time: 10:30 UTC on 2026-11-20
    const now = new Date('2026-11-20T10:30:00.000Z');
    const slots = buildSlotRanges({
      doctorProfileId: 'doc-test',
      date: '2026-11-20',
      startHour: 9,
      endHour: 13,
      slotLengthMinutes: 30,
      timeZone: 'UTC',
      skipBefore: now,
    });

    // 09:00, 09:30, 10:00 start times are <= 10:30, so they must be skipped.
    // 10:30 slot starts exactly at now, so start <= skipBefore skips it.
    // Slots remaining must be 11:00-11:30, 11:30-12:00, 12:00-12:30, 12:30-13:00 (4 slots)
    expect(slots.length).toBe(4);
    expect(slots[0].startTime.toISOString()).toBe('2026-11-20T11:00:00.000Z');
    expect(slots[slots.length - 1].endTime.toISOString()).toBe('2026-11-20T13:00:00.000Z');
  });

  it('omits trailing remainder when window duration is not cleanly divisible in buildSlotRanges', () => {
    // 9 to 11 is 120 minutes. With slotLengthMinutes: 50:
    // Slot 1: 09:00 - 09:50
    // Slot 2: 09:50 - 10:40
    // Remainder 10:40 - 11:00 is only 20 mins, so it is omitted.
    const slots = buildSlotRanges({
      doctorProfileId: 'doc-test',
      date: '2026-11-25',
      startHour: 9,
      endHour: 11,
      slotLengthMinutes: 50,
      timeZone: 'UTC',
    });
    expect(slots.length).toBe(2);
    expect(slots[0].startTime.toISOString()).toBe('2026-11-25T09:00:00.000Z');
    expect(slots[0].endTime.toISOString()).toBe('2026-11-25T09:50:00.000Z');
    expect(slots[1].startTime.toISOString()).toBe('2026-11-25T09:50:00.000Z');
    expect(slots[1].endTime.toISOString()).toBe('2026-11-25T10:40:00.000Z');
  });

  it('rejects invalid slotLengthMinutes directly in buildSlotRanges', () => {
    expect(() =>
      buildSlotRanges({
        doctorProfileId: 'doc-test',
        date: '2026-11-25',
        startHour: 9,
        endHour: 17,
        slotLengthMinutes: 0,
        timeZone: 'UTC',
      }),
    ).toThrow('slotLengthMinutes must be a positive integer.');

    expect(() =>
      buildSlotRanges({
        doctorProfileId: 'doc-test',
        date: '2026-11-25',
        startHour: 9,
        endHour: 17,
        slotLengthMinutes: -10,
        timeZone: 'UTC',
      }),
    ).toThrow('slotLengthMinutes must be a positive integer.');
  });

  it('rejects invalid startHour and endHour directly in buildSlotRanges', () => {
    expect(() =>
      buildSlotRanges({
        doctorProfileId: 'doc-test',
        date: '2026-11-25',
        startHour: 18,
        endHour: 9,
        slotLengthMinutes: 30,
        timeZone: 'UTC',
      }),
    ).toThrow('startHour must be before endHour, both within 0-24.');

    expect(() =>
      buildSlotRanges({
        doctorProfileId: 'doc-test',
        date: '2026-11-25',
        startHour: -1,
        endHour: 10,
        slotLengthMinutes: 30,
        timeZone: 'UTC',
      }),
    ).toThrow('startHour must be before endHour, both within 0-24.');

    expect(() =>
      buildSlotRanges({
        doctorProfileId: 'doc-test',
        date: '2026-11-25',
        startHour: 9,
        endHour: 25,
        slotLengthMinutes: 30,
        timeZone: 'UTC',
      }),
    ).toThrow('startHour must be before endHour, both within 0-24.');
  });

  it('rejects invalid date format directly in buildSlotRanges', () => {
    expect(() =>
      buildSlotRanges({
        doctorProfileId: 'doc-test',
        date: 'invalid-date',
        startHour: 9,
        endHour: 17,
        slotLengthMinutes: 30,
        timeZone: 'UTC',
      }),
    ).toThrow('date must be a valid ISO date.');

    expect(() =>
      buildSlotRanges({
        doctorProfileId: 'doc-test',
        date: '2026-11-25',
        startHour: 9,
        endHour: 17,
        slotLengthMinutes: 30,
        timeZone: 'Invalid/Zone',
      }),
    ).toThrow('date and timeZone must produce a valid slot range.');
  });

  it('skips overlapping slots with varied existing slot formats in buildSlotRanges', () => {
    const baseInput = {
      doctorProfileId: 'doc-test',
      date: '2026-11-25',
      startHour: 9,
      endHour: 12,
      slotLengthMinutes: 60,
      timeZone: 'UTC',
    };
    // 9-10, 10-11, 11-12 (3 slots)
    // Overlap 10-11 using object with Date
    const start10 = new Date('2026-11-25T10:00:00.000Z');
    const end11 = new Date('2026-11-25T11:00:00.000Z');
    const slots = buildSlotRanges(baseInput, [{ startTime: start10, endTime: end11 }]);
    expect(slots.length).toBe(2);
    expect(slots[0].startTime.toISOString()).toBe('2026-11-25T09:00:00.000Z');
    expect(slots[1].startTime.toISOString()).toBe('2026-11-25T11:00:00.000Z');

    // Overlap 9-10 using raw timestamp number
    const start9 = new Date('2026-11-25T09:00:00.000Z').getTime();
    const slotsNum = buildSlotRanges(baseInput, [start9]);
    expect(slotsNum.length).toBe(2);
    expect(slotsNum[0].startTime.toISOString()).toBe('2026-11-25T10:00:00.000Z');
  });
});
