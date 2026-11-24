import type { AppointmentStatus } from '@prisma/client';

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

/**
 * Checks whether an appointment can transition to completed or no_show given its slot timing.
 * Completed and no_show are only allowed once the slot has started (allowing a configurable grace window).
 */
export function canFinalizeAppointment(
  slotStartTime: Date | null | undefined,
  now = new Date(),
  graceWindowMs = 0,
): boolean {
  if (!slotStartTime) return false;
  return now.getTime() + graceWindowMs >= slotStartTime.getTime();
}
