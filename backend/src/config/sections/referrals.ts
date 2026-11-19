import { positiveNumber } from '../helpers';

// Referral expiry (Phase 3, issue #8). A referral still `pending` this
// long after it was created — or after it last returned to `pending` —
// is moved to the terminal `expired` state by an interval sweep
// (src/jobs/referral-expiry.ts). A v1 default, not a tuned value.
export const referrals = {
  pendingTtlDays: positiveNumber(process.env.REFERRAL_PENDING_TTL_DAYS, 14),
  expirySweepIntervalSeconds: positiveNumber(process.env.REFERRAL_EXPIRY_SWEEP_INTERVAL_SECONDS, 60 * 60),
} as const;
