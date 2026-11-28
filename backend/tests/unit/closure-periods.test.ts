import { describe, expect, it } from 'vitest';
import {
  calendarDateString,
  closureWindow,
  excludeClosedSlots,
  isSlotClosed,
} from '../../src/modules/availability/closure-periods';

describe('closure period windows (Phase 2, issue #131)', () => {
  const slot = (startIso: string, minutes = 30) => {
    const startTime = new Date(startIso);
    return { startTime, endTime: new Date(startTime.getTime() + minutes * 60_000) };
  };

  it('covers all of a single all-day closure (half-open, so the day is included)', () => {
    const window = closureWindow({ startDate: '2026-12-25', endDate: '2026-12-25', timeZone: 'UTC' });
    expect(window.start.toISOString()).toBe('2026-12-25T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-12-26T00:00:00.000Z');
  });

  it('includes the last day of a multi-day closure', () => {
    const window = closureWindow({ startDate: '2026-12-24', endDate: '2026-12-26', timeZone: 'UTC' });
    expect(window.start.toISOString()).toBe('2026-12-24T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-12-27T00:00:00.000Z');
  });

  it('reads the all-day range in the closure’s own time zone', () => {
    // New York is UTC-5 in December: midnight local is 05:00Z.
    const window = closureWindow({ startDate: '2026-12-25', endDate: '2026-12-25', timeZone: 'America/New_York' });
    expect(window.start.toISOString()).toBe('2026-12-25T05:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-12-26T05:00:00.000Z');
  });

  it('is 23 hours long on a spring-forward day and 25 hours on a fall-back day', () => {
    const hours = (w: { start: Date; end: Date }) => (w.end.getTime() - w.start.getTime()) / 3_600_000;
    // UK clocks change 2026-03-29 (forward) and 2026-10-25 (back).
    expect(hours(closureWindow({ startDate: '2026-03-29', endDate: '2026-03-29', timeZone: 'Europe/London' }))).toBe(23);
    expect(hours(closureWindow({ startDate: '2026-10-25', endDate: '2026-10-25', timeZone: 'Europe/London' }))).toBe(25);
  });

  it('treats a slot straddling the closure boundary as closed', () => {
    const window = closureWindow({ startDate: '2026-12-25', endDate: '2026-12-25', timeZone: 'UTC' });
    expect(isSlotClosed(slot('2026-12-24T23:45:00.000Z'), [window])).toBe(true);
    expect(isSlotClosed(slot('2026-12-25T23:45:00.000Z'), [window])).toBe(true);
    expect(isSlotClosed(slot('2026-12-26T00:00:00.000Z'), [window])).toBe(false);
    expect(isSlotClosed(slot('2026-12-24T23:00:00.000Z'), [window])).toBe(false);
  });

  it('drops exactly the closed slots and keeps the rest in order', () => {
    const window = closureWindow({ startDate: '2026-12-25', endDate: '2026-12-25', timeZone: 'UTC' });
    const slots = [
      slot('2026-12-24T23:30:00.000Z'),
      slot('2026-12-25T09:00:00.000Z'),
      slot('2026-12-25T17:30:00.000Z'),
      slot('2026-12-26T09:00:00.000Z'),
    ];
    expect(excludeClosedSlots(slots, [window]).map((s) => s.startTime.toISOString())).toEqual([
      '2026-12-24T23:30:00.000Z',
      '2026-12-26T09:00:00.000Z',
    ]);
    // No windows means no filtering at all.
    expect(excludeClosedSlots(slots, [])).toHaveLength(4);
  });

  it('accepts stored DATE values (UTC midnight) as well as strings', () => {
    expect(calendarDateString(new Date('2026-12-25T00:00:00.000Z'))).toBe('2026-12-25');
    expect(calendarDateString('2026-12-25')).toBe('2026-12-25');
  });
});
