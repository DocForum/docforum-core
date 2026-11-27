import { rateLimit } from 'express-rate-limit';
import { config } from '../config';

// Per-IP request limiter for authenticated API routes (CodeQL
// js/missing-rate-limiting). Window and budget come from
// RATE_LIMIT_WINDOW_SECONDS / RATE_LIMIT_MAX_REQUESTS. `req.ip` honours the
// app's `trust proxy` setting, so clients behind the load balancer are keyed
// by their real address.
export const apiRateLimit = rateLimit({
  windowMs: config.rateLimit.windowSeconds * 1000,
  limit: config.rateLimit.maxRequests,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.', code: 'RATE_LIMITED' },
});
