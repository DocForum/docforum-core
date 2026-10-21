import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { HttpError } from '../http-error';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../logger';
import { localizedErrorMessage, resolveLocale } from '../i18n';

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

  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    requestLogger.warn({ err }, 'Unique constraint violation');
    res.status(409).json({ message: 'A record with this value already exists.' });
    return;
  }

  // Log the full error (including stack) server-side only. The response
  // body is the safe envelope and never leaks internal details.
  requestLogger.error({ err }, 'Unhandled error');
  res.status(500).json({ message: 'Internal server error.' });
}
