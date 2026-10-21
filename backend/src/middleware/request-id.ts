// Request ids (Phase 8, issue #43). Every request gets one, so an audit
// event can be tied back to the HTTP request (and its logs) that caused it.
// An inbound `X-Request-Id` (e.g. from Render's proxy or a client) is kept
// when it's a sane token; otherwise a fresh UUID is minted. Echoed back in
// the response header either way.
//
// Phase 9, issue #46: this middleware also attaches a request-scoped
// child logger to `req.log`, so controllers and the error handler can log with
// the request id attached without having to pluck it out of the request
// themselves.
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AuditActor } from '../modules/audit/services';
import type { Logger } from 'pino';
import { requestLogger } from '../logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      // Request-scoped child logger (Phase 9, issue #46). Always set by
      // the requestId middleware below.
      log?: Logger;
    }
  }
}

export const REQUEST_ID_HEADER = 'x-request-id';

// Bounded charset and length: the value is stored and logged, so it must
// not be a vehicle for arbitrary client data.
const ACCEPTABLE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestId(req: Request, res: Response, next: NextFunction) {
  const inbound = req.get(REQUEST_ID_HEADER);
  const id = inbound && ACCEPTABLE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
  req.requestId = id;
  req.log = requestLogger({ requestId: id });
  res.set('X-Request-Id', id);
  next();
}

/** The audit actor for an authenticated request: who, in which role, under
 * which request id. Controllers pass this into the service whose state
 * change is being audited. */
export function auditActor(req: Request): AuditActor {
  return { userId: req.user?.id ?? null, role: req.user?.role ?? null, requestId: req.requestId ?? null };
}
