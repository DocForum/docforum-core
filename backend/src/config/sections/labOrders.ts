// Issue #313: TTL config for lab-order expiry.
// Routine orders expire after 30 days; urgent after 7 days by default.
// Override with LAB_ORDER_ROUTINE_TTL_DAYS / LAB_ORDER_URGENT_TTL_DAYS.
export const labOrders = {
  routineTtlDays: Number(process.env.LAB_ORDER_ROUTINE_TTL_DAYS ?? 30),
  urgentTtlDays: Number(process.env.LAB_ORDER_URGENT_TTL_DAYS ?? 7),
} as const;
