import { positiveNumber } from '../helpers';

// Doctor-side appointment status transitions (Phase 2, issue #299).
// Completion and no-show updates require that the slot has started.
// A configurable grace window (in seconds) allows early completion
// slightly ahead of slot startTime if configured.
export const appointments = {
  completionGraceSeconds: positiveNumber(process.env.APPOINTMENT_COMPLETION_GRACE_SECONDS, 0),
} as const;
