import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { HttpError } from '../http-error';
import { localizedErrorMessage, resolveLocale } from '../i18n';

// docforum-web's api-client.ts assumes an error envelope of
// `{ message: string }` (documented as unconfirmed there) — this is the
// implementation that assumption is checked against. Keep them in sync.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    // `code` is only present when the thrower supplied one — the envelope
    // for every existing error is unchanged (`{ message }`).
    const locale = resolveLocale(req.user?.locale, req.headers['accept-language']);
    const message = localizedErrorMessage(locale, err.code, err.message);
    res.status(err.status).json(err.code ? { message, code: err.code } : { message });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ message: err.issues.map((issue) => issue.message).join('; ') });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    res.status(409).json({ message: 'A record with this value already exists.' });
    return;
  }

  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ message: 'Internal server error.' });
}
