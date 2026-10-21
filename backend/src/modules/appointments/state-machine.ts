import type { AppointmentStatus } from '@prisma/client';

const transitions: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  scheduled: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
};

/** Returns the next state or null when a requested lifecycle transition is illegal. */
export function transitionAppointmentStatus(
  current: AppointmentStatus,
  requested: AppointmentStatus,
): AppointmentStatus | null {
  return transitions[current].includes(requested) ? requested : null;
}
