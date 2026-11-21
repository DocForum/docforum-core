import { positiveNumber } from '../helpers';

// Appointment cancellation and reschedule cutoff policy (Phase 2, issue #292, #293).
export const appointments = {
  cutoffHours: positiveNumber(process.env.APPOINTMENT_CUTOFF_HOURS, 2),
} as const;
