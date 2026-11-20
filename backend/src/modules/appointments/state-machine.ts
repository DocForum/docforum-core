import type { AppointmentStatus } from '@prisma/client';
import { HttpError } from '../../http-error';

const transitions: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  scheduled: ['completed', 'cancelled', 'late_cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  late_cancelled: [],
  no_show: [],
};

/** Returns the next state or null when a requested lifecycle transition is illegal. */
export function transitionAppointmentStatus(
  current: AppointmentStatus,
  requested: AppointmentStatus,
): AppointmentStatus | null {
  return transitions[current].includes(requested) ? requested : null;
}

export const APPOINTMENT_NOT_STARTED_CODE = 'APPOINTMENT_NOT_STARTED';

/**
 * Validates doctor-side lifecycle transitions (issue #299):
 * - Status must be `scheduled`.
 * - `cancelled` is permitted at any time.
 * - `completed` and `no_show` require an active slot that has already started
 *   (or within the configurable grace window).
 * - Appointments with released slots (no slot start time) cannot be completed or marked no-show.
 */
export function assertDoctorCanTransitionStatus(
  current: AppointmentStatus,
  requested: AppointmentStatus,
  slotStartTime: Date | null,
  now = new Date(),
  graceSeconds = 0,
): void {
  if (transitionAppointmentStatus(current, requested) === null) {
    throw new HttpError(409, 'Only a scheduled appointment can change status.');
  }

  if (requested === 'completed' || requested === 'no_show') {
    if (!slotStartTime) {
      throw new HttpError(
        409,
        'Appointments cannot be marked completed or no-show before the scheduled start time.',
        APPOINTMENT_NOT_STARTED_CODE,
      );
    }

    const effectiveStart = new Date(slotStartTime.getTime() - graceSeconds * 1000);
    if (now.getTime() < effectiveStart.getTime()) {
      throw new HttpError(
        409,
        'Appointments cannot be marked completed or no-show before the scheduled start time.',
        APPOINTMENT_NOT_STARTED_CODE,
      );
    }
  }
}
