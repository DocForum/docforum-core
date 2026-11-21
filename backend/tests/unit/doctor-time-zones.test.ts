import { describe, expect, it } from 'vitest';
import {
  assertValidTimeZone,
  getCalendarDayBounds,
  parseScheduleDateRange,
} from '../../src/modules/appointments/time-zones';

describe('doctor time zones & day bounds (issues #290, #291)', () => {
  it('validates IANA time zone identifiers', () => {
    expect(() => assertValidTimeZone('Africa/Lagos')).not.toThrow();
    expect(() => assertValidTimeZone('America/New_York')).not.toThrow();
    expect(() => assertValidTimeZone('Europe/London')).not.toThrow();
    expect(() => assertValidTimeZone('UTC')).not.toThrow();

    expect(() => assertValidTimeZone('Fake/Zone')).toThrowError(
      expect.objectContaining({
        status: 400,
        code: 'INVALID_TIME_ZONE',
      }),
    );
  });

  it('computes standard 24h calendar day bounds in Africa/Lagos (UTC+1)', () => {
    // 2026-11-20 at 14:00 UTC is 15:00 in Lagos
    const now = new Date('2026-11-20T14:00:00.000Z');
    const { start, end } = getCalendarDayBounds('Africa/Lagos', now);

    // Midnight Lagos is 23:00 UTC previous day
    expect(start.toISOString()).toBe('2026-11-19T23:00:00.000Z');
    // Next midnight Lagos is 23:00 UTC today
    expect(end.toISOString()).toBe('2026-11-20T23:00:00.000Z');
    const durationHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    expect(durationHours).toBe(24);
  });

  it('computes standard 24h calendar day bounds in America/New_York (UTC-5 in winter)', () => {
    // 2026-01-15 at 18:00 UTC is 13:00 in New York
    const now = new Date('2026-01-15T18:00:00.000Z');
    const { start, end } = getCalendarDayBounds('America/New_York', now);

    // Midnight New York (EST = UTC-5) is 05:00 UTC on Jan 15
    expect(start.toISOString()).toBe('2026-01-15T05:00:00.000Z');
    // Next midnight New York is 05:00 UTC on Jan 16
    expect(end.toISOString()).toBe('2026-01-16T05:00:00.000Z');
    const durationHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    expect(durationHours).toBe(24);
  });

  it('correctly produces 23 hours on DST spring forward day in America/New_York (2026-03-08)', () => {
    // On 2026-03-08, clocks jump from 2am EST to 3am EDT
    const now = new Date('2026-03-08T12:00:00.000Z');
    const { start, end } = getCalendarDayBounds('America/New_York', now);

    // Midnight start of Mar 8 in EST (UTC-5) is 05:00 UTC
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    // Midnight start of Mar 9 in EDT (UTC-4) is 04:00 UTC
    expect(end.toISOString()).toBe('2026-03-09T04:00:00.000Z');

    const durationHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    expect(durationHours).toBe(23);
  });

  it('correctly produces 25 hours on DST fall back day in America/New_York (2026-11-01)', () => {
    // On 2026-11-01, clocks repeat 1am-2am EDT -> EST
    const now = new Date('2026-11-01T12:00:00.000Z');
    const { start, end } = getCalendarDayBounds('America/New_York', now);

    // Midnight start of Nov 1 in EDT (UTC-4) is 04:00 UTC
    expect(start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    // Midnight start of Nov 2 in EST (UTC-5) is 05:00 UTC
    expect(end.toISOString()).toBe('2026-11-02T05:00:00.000Z');

    const durationHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    expect(durationHours).toBe(25);
  });

  it('parses schedule date range with defaults', () => {
    const now = new Date('2026-11-20T12:00:00.000Z');
    const { start, end } = parseScheduleDateRange('UTC', undefined, undefined, now);

    expect(start.toISOString()).toBe('2026-11-20T00:00:00.000Z');
    // Default span is 14 days
    expect(end.toISOString()).toBe('2026-12-04T00:00:00.000Z');
  });

  it('rejects schedule range where from is after to', () => {
    expect(() =>
      parseScheduleDateRange('UTC', '2026-11-25', '2026-11-20'),
    ).toThrowError(
      expect.objectContaining({
        status: 400,
        code: 'INVALID_DATE_RANGE',
      }),
    );
  });

  it('rejects schedule range exceeding maximum span (31 days)', () => {
    expect(() =>
      parseScheduleDateRange('UTC', '2026-11-01', '2026-12-15'),
    ).toThrowError(
      expect.objectContaining({
        status: 400,
        code: 'DATE_RANGE_TOO_LARGE',
      }),
    );
  });
});
