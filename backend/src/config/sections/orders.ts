export const orders = {
  confirmationWindowHours: Number(process.env.ORDER_CONFIRMATION_WINDOW_HOURS ?? 72),
  expiryIntervalSeconds: Number(process.env.ORDER_EXPIRY_INTERVAL_SECONDS ?? 300),
} as const;
