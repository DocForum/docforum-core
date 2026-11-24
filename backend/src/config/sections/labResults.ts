import { positiveNumber } from '../helpers';

export const labResults = {
  maxBytes: positiveNumber(process.env.LAB_RESULT_MAX_BYTES, 10 * 1024 * 1024),
  // Issue #72 (PRD §8.2.7): hours an abnormal/critical result may sit
  // unacknowledged before it is escalated to the admin queue. Fixed at attach
  // time per result, so changing this never moves an existing deadline.
  escalationHours: positiveNumber(process.env.LAB_RESULT_ESCALATION_HOURS, 24),
  // How often the escalation sweep runs (src/jobs/lab-result-escalation.ts).
  escalationSweepSeconds: positiveNumber(process.env.LAB_RESULT_ESCALATION_SWEEP_SECONDS, 300),
} as const;
