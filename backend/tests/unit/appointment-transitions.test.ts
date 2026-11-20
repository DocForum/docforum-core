import { describe, expect, it } from 'vitest';
import {
  APPOINTMENT_NOT_STARTED_CODE,
  assertDoctorCanTransitionStatus,
  transitionAppointmentStatus,
} from '../../src/modules/appointments/state-machine';
import { HttpError } from '../../src/http-error';

describe('doctor appointment lifecycle transitions (issue #299)', () => {
  const baseTime = new Date('2026-11-20T14:00:00.000Z');

  it('allows transition to cancelled at any time, even without a slot', () => {
    expect(() =>
      assertDoctorCanTransitionStatus('scheduled', 'cancelled', null, baseTime, 0),
    ).not.toThrow();

    const futureSlot = new Date('2026-11-21T14:00:00.000Z');
    expect(() =>
      assertDoctorCanTransitionStatus('scheduled', 'cancelled', futureSlot, baseTime, 0),
    ).not.toThrow();
  });

  it('rejects completed and no_show when appointment has a released slot (no start time)', () => {
    for (const requested of ['completed', 'no_show'] as const) {
      try {
        assertDoctorCanTransitionStatus('scheduled', requested, null, baseTime, 0);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        const httpErr = err as HttpError;
        expect(httpErr.status).toBe(409);
        expect(httpErr.code).toBe(APPOINTMENT_NOT_STARTED_CODE);
        expect(httpErr.message).toBe(
          'Appointments cannot be marked completed or no-show before the scheduled start time.',
        );
      }
    }
  });

  it('rejects completed and no_show before slot start time when grace is 0', () => {
    const futureSlot = new Date(baseTime.getTime() + 60_000); // 1 minute in future

    for (const requested of ['completed', 'no_show'] as const) {
      try {
        assertDoctorCanTransitionStatus('scheduled', requested, futureSlot, baseTime, 0);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        const httpErr = err as HttpError;
        expect(httpErr.status).toBe(409);
        expect(httpErr.code).toBe(APPOINTMENT_NOT_STARTED_CODE);
        expect(httpErr.message).toBe(
          'Appointments cannot be marked completed or no-show before the scheduled start time.',
        );
      }
    }
  });

  it('allows completed and no_show before slot start time when within grace window', () => {
    const futureSlot = new Date(baseTime.getTime() + 30_000); // 30s in future
    const graceSeconds = 60; // 60s grace

    for (const requested of ['completed', 'no_show'] as const) {
      expect(() =>
        assertDoctorCanTransitionStatus('scheduled', requested, futureSlot, baseTime, graceSeconds),
      ).not.toThrow();
    }
  });

  it('allows completed and no_show after slot has started', () => {
    const pastSlot = new Date(baseTime.getTime() - 60_000); // 1 minute in past

    for (const requested of ['completed', 'no_show'] as const) {
      expect(() =>
        assertDoctorCanTransitionStatus('scheduled', requested, pastSlot, baseTime, 0),
      ).not.toThrow();
    }

    // Exactly at start time
    for (const requested of ['completed', 'no_show'] as const) {
      expect(() =>
        assertDoctorCanTransitionStatus('scheduled', requested, baseTime, baseTime, 0),
      ).not.toThrow();
    }
  });

  it('rejects any transition when appointment is already in a terminal state', () => {
    const terminalStates = ['completed', 'cancelled', 'late_cancelled', 'no_show'] as const;
    const requestedStates = ['completed', 'cancelled', 'no_show'] as const;

    for (const current of terminalStates) {
      for (const requested of requestedStates) {
        expect(() =>
          assertDoctorCanTransitionStatus(current, requested, baseTime, baseTime, 0),
        ).toThrowError('Only a scheduled appointment can change status.');
      }
    }
  });

  it('preserves transitionAppointmentStatus pure behavior', () => {
    expect(transitionAppointmentStatus('scheduled', 'completed')).toBe('completed');
    expect(transitionAppointmentStatus('scheduled', 'no_show')).toBe('no_show');
    expect(transitionAppointmentStatus('scheduled', 'cancelled')).toBe('cancelled');
    expect(transitionAppointmentStatus('completed', 'scheduled')).toBeNull();
  });
});
