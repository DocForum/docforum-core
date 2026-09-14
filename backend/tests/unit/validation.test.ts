import { describe, expect, it } from 'vitest';
import { loginSchema, signupSchema } from '../../src/modules/auth/validation';
import { generateSlotsSchema } from '../../src/modules/availability/validation';

describe('signupSchema', () => {
  it('accepts a valid patient signup', () => {
    const result = signupSchema.safeParse({
      role: 'patient',
      email: 'patient@example.com',
      password: 'longenough',
      fullName: 'Ada Lovelace',
    });
    expect(result.success).toBe(true);
  });

  it('rejects role "facility" — self-serve signup is patient/doctor only (PRD OQ-2)', () => {
    const result = signupSchema.safeParse({
      role: 'facility',
      email: 'lab@example.com',
      password: 'longenough',
      fullName: 'Some Lab',
    });
    expect(result.success).toBe(false);
  });

  it('rejects role "admin"', () => {
    const result = signupSchema.safeParse({
      role: 'admin',
      email: 'admin@example.com',
      password: 'longenough',
      fullName: 'Admin',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a short password', () => {
    const result = signupSchema.safeParse({
      role: 'patient',
      email: 'patient@example.com',
      password: 'short',
      fullName: 'Ada Lovelace',
    });
    expect(result.success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('rejects a malformed email', () => {
    const result = loginSchema.safeParse({ email: 'not-an-email', password: 'x' });
    expect(result.success).toBe(false);
  });
});

describe('generateSlotsSchema', () => {
  it('accepts a valid slot-generation request', () => {
    const result = generateSlotsSchema.safeParse({
      date: '2026-09-20',
      startHour: 9,
      endHour: 17,
      slotLengthMinutes: 30,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed date', () => {
    const result = generateSlotsSchema.safeParse({
      date: '09/20/2026',
      startHour: 9,
      endHour: 17,
      slotLengthMinutes: 30,
    });
    expect(result.success).toBe(false);
  });
});
