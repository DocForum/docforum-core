// Guardians and dependents (Phase 8, issue #42, docs/adr/0011): the pure
// parts — age-of-majority date math and the strict request schemas.
// Database-backed authorisation is in tests/integration/guardianship.test.mts.
import { describe, expect, it } from 'vitest';
import { isMinor, majorityDate } from '../../src/modules/patients/services/majority';
import { createDependentSchema } from '../../src/modules/patients/validation';
import { bookSlotSchema } from '../../src/modules/appointments/validation';

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('age of majority', () => {
  it('is reached at 00:00 UTC on the Nth birthday, not a moment before', () => {
    const dob = utc('2008-06-15');
    expect(majorityDate(dob, 18).toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(isMinor(dob, 18, new Date('2026-06-14T23:59:59.999Z'))).toBe(true);
    expect(isMinor(dob, 18, new Date('2026-06-15T00:00:00.000Z'))).toBe(false);
  });

  it('treats a 29 February birthday as reaching majority on 1 March in a non-leap year', () => {
    const dob = utc('2008-02-29');
    expect(majorityDate(dob, 18).toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(isMinor(dob, 18, utc('2026-02-28'))).toBe(true);
    expect(isMinor(dob, 18, utc('2026-03-01'))).toBe(false);
    // ...and on 29 February itself when the majority year is a leap year.
    expect(majorityDate(utc('2012-02-29'), 16).toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('honours a different configured age', () => {
    expect(isMinor(utc('2010-01-01'), 16, utc('2025-12-31'))).toBe(true);
    expect(isMinor(utc('2010-01-01'), 16, utc('2026-01-01'))).toBe(false);
  });

  it('treats a newborn as a minor', () => {
    expect(isMinor(utc('2026-10-17'), 18, utc('2026-10-17'))).toBe(true);
  });
});

describe('createDependentSchema', () => {
  it('accepts a name and a real calendar date', () => {
    const parsed = createDependentSchema.parse({ fullName: '  Ada  ', dateOfBirth: '2020-02-29' });
    expect(parsed.fullName).toBe('Ada');
    expect(parsed.dateOfBirth.toISOString()).toBe('2020-02-29T00:00:00.000Z');
  });

  it('rejects impossible dates instead of rolling them over', () => {
    expect(createDependentSchema.safeParse({ fullName: 'Ada', dateOfBirth: '2021-02-29' }).success).toBe(false);
    expect(createDependentSchema.safeParse({ fullName: 'Ada', dateOfBirth: '2020-13-01' }).success).toBe(false);
    expect(createDependentSchema.safeParse({ fullName: 'Ada', dateOfBirth: '01/02/2020' }).success).toBe(false);
  });

  it('is strict: a body that tries to link an existing profile or user is rejected', () => {
    for (const extra of [{ patientProfileId: 'p' }, { userId: 'u' }, { guardianUserId: 'g' }]) {
      expect(createDependentSchema.safeParse({ fullName: 'Ada', dateOfBirth: '2020-01-01', ...extra }).success).toBe(false);
    }
  });

  it('requires a non-empty name', () => {
    expect(createDependentSchema.safeParse({ fullName: '   ', dateOfBirth: '2020-01-01' }).success).toBe(false);
  });
});

describe('bookSlotSchema', () => {
  it('keeps self-booking unchanged and accepts an optional patientProfileId', () => {
    expect(bookSlotSchema.parse({ availabilitySlotId: 's' })).toEqual({ availabilitySlotId: 's' });
    expect(bookSlotSchema.parse({ availabilitySlotId: 's', patientProfileId: 'p' })).toEqual({
      availabilitySlotId: 's',
      patientProfileId: 'p',
    });
    expect(bookSlotSchema.safeParse({ availabilitySlotId: 's', patientProfileId: '' }).success).toBe(false);
  });
});
