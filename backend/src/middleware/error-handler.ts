import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { HttpError } from '../http-error';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../logger';
import { localizedErrorMessage, resolveLocale } from '../i18n';

/** Prisma known-request codes mapped to a client status (issue #334). */
export const PRISMA_CLIENT_ERRORS: Readonly<Record<string, { status: number; message: string; log: string }>> = {
  // Unique constraint failed.
  P2002: { status: 409, message: 'A record with this value already exists.', log: 'Unique constraint violation' },
  // Foreign key constraint failed: the request names a record that doesn't
  // exist (create/update), or one that other records still depend on.
  P2003: {
    status: 422,
    message: 'The request refers to a record that does not exist or is still in use.',
    log: 'Foreign key constraint violation',
  },
  // An update/delete (or a required connect) matched no row.
  P2025: { status: 404, message: 'Record not found.', log: 'Record not found' },
};

// docforum-web's api-client.ts assumes an error envelope of
// `{ message: string }` (documented as unconfirmed there) — this is the
// implementation that assumption is checked against. Keep them in sync.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestLogger: Logger =
    (req as Request & { log?: Logger }).log ?? rootLogger;

  if (err instanceof HttpError) {
    // `code` is only present when the thrower supplied one — the envelope
    // for every existing error is unchanged (`{ message }`).
    if (err.status >= 500) {
      requestLogger.error({ err }, 'Request failed');
    } else {
      requestLogger.warn({ err }, 'Request rejected');
    }
    const locale = resolveLocale(req.user?.locale, req.headers['accept-language']);
    const message = localizedErrorMessage(locale, err.code, err.message);
    res.status(err.status).json(err.code ? { message, code: err.code } : { message });
    return;
  }

  if (err instanceof ZodError) {
    requestLogger.warn({ err }, 'Request validation failed');
    res.status(400).json({ message: err.issues.map((issue) => issue.message).join('; ') });
    return;
  }

  // Prisma request errors that are the client's fault (issue #334). The
  // messages are fixed strings: Prisma's own `message`/`meta` name tables,
  // columns and constraints, so they are logged server-side and never sent.
  // Errors thrown inside `$transaction` reach here as the same class, so
  // they map the same way.
  const prismaMapping = err instanceof Prisma.PrismaClientKnownRequestError ? PRISMA_CLIENT_ERRORS[err.code] : undefined;
  if (prismaMapping) {
    requestLogger.warn({ err }, prismaMapping.log);
    res.status(prismaMapping.status).json({ message: prismaMapping.message });
    return;
  }

  // Log the full error (including stack) server-side only. The response
  // body is the safe envelope and never leaks internal details.
  requestLogger.error({ err }, 'Unhandled error');
  res.status(500).json({ message: 'Internal server error.' });
}
