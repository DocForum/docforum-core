import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { HttpError, ErrorCode } from '../http-error.js';

// docforum-web's api-client.ts assumes an error envelope of
// `{ message: string }` (documented as unconfirmed there) — this is the
// implementation that assumption is checked against. Keep them in sync.
//
// The envelope is now always `{ code, message, details? }`. `message` is
// kept for backwards compatibility; clients should branch on `code`.
export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    const body: ErrorEnvelope = {
      code: err.code,
      message: err.message,
    };
    if (err.details !== undefined) {
      body.details = err.details;
    }
    res.status(err.status).json(body);
    return;
  }

  if (err instanceof ZodError) {
    // All validation failures share a single code; field level details are
    // exposed via `details` so clients can highlight specific inputs.
    const body: ErrorEnvelope = {
      code: ErrorCode.VALIDATION_FAILED,
      message: err.issues.map((issue) => issue.message).join('; '),
      details: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
    };
    res.status(400).json(body);
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    // DB-level uniqueness guarantees are the backstop for booking and
    // slot assignment races. Surface them as a coded conflict.
    const body: ErrorEnvelope = {
      code: ErrorCode.CONFLICT,
      message: 'A record with this value already exists.',
    };
    res.status(409).json(body);
    return;
  }

  // Unknown errors: log internally, leak nothing to the client.
  // eslint-disable-next-line no-console
  console.error(err);
  const body: ErrorEnvelope = {
    code: ErrorCode.INTERNAL,
    message: 'Internal server error.',
  };
  res.status(500).json(body);
}
