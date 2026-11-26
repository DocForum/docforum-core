export const referral = {
  maxHops: Number(process.env.REFERRAL_MAX_HOPS ?? 3),
  pendingTtlDays: Number(process.env.REFERRAL_PENDING_TTL_DAYS ?? 30),
} as const;
