import { positiveNumber } from '../helpers';

export const rateLimit = {
  windowSeconds: positiveNumber(process.env.RATE_LIMIT_WINDOW_SECONDS, 60),
  maxRequests: positiveNumber(process.env.RATE_LIMIT_MAX_REQUESTS, 100),
} as const;
