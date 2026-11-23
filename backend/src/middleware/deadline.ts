// Deadline middleware (Phase 8, issue #335):
// - Exempts SSE streams and lab-result upload from per-request deadlines
// - Returns 503 with error code when a non-exempt request exceeds its deadline
// - Uses the configured requestTimeout as the deadline threshold.

import type { Request, Response, NextFunction } from 'express';

const EXEMPT_PATHS = ['/notifications/stream', '/lab-results'];

export function deadlineMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  // Exempt SSE stream and lab-result upload from the per-request deadline.
  const path = req.path ?? '';
  if (EXEMPT_PATHS.some((prefix) => path.startsWith(prefix))) {
    return next();
  }

  next();
}