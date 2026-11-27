import { positiveNumber } from '../helpers';

export const orders = {
  confirmationWindowHours: Number(process.env.ORDER_CONFIRMATION_WINDOW_HOURS ?? 72),
  expiryIntervalSeconds: Number(process.env.ORDER_EXPIRY_INTERVAL_SECONDS ?? 300),
  // Issue #316: largest accepted fulfillment proof file, in bytes.
  proofMaxBytes: positiveNumber(process.env.FULFILLMENT_PROOF_MAX_BYTES, 10 * 1024 * 1024),
} as const;
