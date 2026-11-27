import { positiveNumber } from '../helpers';

// Issue #313: how long an issued lab order may wait for fulfilment before the
// expiry sweep (jobs/lab-order-expiry.ts) moves it to `expired` and triggers
// the refund. Set at issuance (hard rule 1: part of the issued row).
export const labOrders = {
  routineTtlDays: positiveNumber(process.env.LAB_ORDER_ROUTINE_TTL_DAYS, 30),
  urgentTtlDays: positiveNumber(process.env.LAB_ORDER_URGENT_TTL_DAYS, 7),
} as const;
