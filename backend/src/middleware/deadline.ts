// Per-request deadline (Phase 8, issue #335). A non-streaming request that
// has not produced a response within the budget gets 503 REQUEST_TIMEOUT,
// so a hung database call cannot hold a client (and its socket) forever.
// The handler itself keeps running; its late response is dropped (the
// error handler ignores errors once headers are sent).
//
// Exempt: the SSE stream, which is open by design, and the routes that move
// whole files (lab-result upload/download, consultation attachment files,
// patient-export download), which
// are bounded by the server-level requestTimeout and their size caps.
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';

const EXEMPT = [
  /^\/notifications\/stream\/?$/,
  /^\/lab-results(\/|$)/,
  /^\/orders\/lab-orders\/[^/]+\/result\/?$/,
  /^\/consultations\/messages\/attachments\/[^/]+\/file\/?$/,
  /^\/patients\/me\/export\/[^/]+\/download\/?$/,
];

export function isDeadlineExempt(path: string): boolean {
  return EXEMPT.some((pattern) => pattern.test(path));
}

export function requestDeadline(timeoutMs: number = config.http.requestDeadline) {
  return function deadlineMiddleware(req: Request, res: Response, next: NextFunction) {
    if (isDeadlineExempt(req.path)) {
      next();
      return;
    }
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      res.status(503).json({ message: 'The request took too long to complete.', code: 'REQUEST_TIMEOUT' });
    }, timeoutMs);
    timer.unref();
    const clear = () => clearTimeout(timer);
    res.once('finish', clear);
    res.once('close', clear);
    next();
  };
}
