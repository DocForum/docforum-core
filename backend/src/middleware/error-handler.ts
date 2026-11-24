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

/**
 * Issue #333: body-parser (express.json()) failures are client errors, not
 * 500s. Each `type` maps to a fixed status and a stable `code`. Routes with
 * their own body handling (the lab-result raw-body route) convert these
 * errors to their own HttpError first, so their codes are kept.
 */
const BODY_PARSER_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  'entity.parse.failed': { status: 400, code: 'INVALID_JSON', message: 'The request body is not valid JSON.' },
  'entity.too.large': { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' },
  'encoding.unsupported': { status: 415, code: 'UNSUPPORTED_ENCODING', message: 'The request body encoding is not supported.' },
  'charset.unsupported': { status: 415, code: 'UNSUPPORTED_CHARSET', message: 'The request body charset is not supported.' },
  'request.aborted': { status: 400, code: 'REQUEST_ABORTED', message: 'The request body was not fully received.' },
  'request.size.invalid': { status: 400, code: 'INVALID_REQUEST_BODY', message: 'The request body could not be read.' },
};

// A corrupt compressed body (e.g. `Content-Encoding: gzip` with bytes that
// aren't gzip) surfaces from body-parser as an http-errors 400 with NO
// `type`. It is the same client mistake, so it gets the same treatment.
const UNREADABLE_BODY = { status: 400, code: 'INVALID_REQUEST_BODY', message: 'The request body could not be read.' };

/** Returns the mapping for a body-parser error, or undefined for anything
 * else. Exported for unit tests. */
export function bodyParserErrorMapping(err: unknown) {
  if (typeof err !== 'object' || err === null || err instanceof HttpError) return undefined;
  const { type, status, expose } = err as { type?: unknown; status?: unknown; expose?: unknown };
  if (typeof type === 'string') return Object.hasOwn(BODY_PARSER_ERRORS, type) ? BODY_PARSER_ERRORS[type] : undefined;
  return status === 400 && expose === true ? UNREADABLE_BODY : undefined;
}

// docforum-web's api-client.ts assumes an error envelope of
// `{ message: string }` (documented as unconfirmed there) — this is the
// implementation that assumption is checked against. Keep them in sync.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestLogger: Logger =
    (req as Request & { log?: Logger }).log ?? rootLogger;

  const bodyError = bodyParserErrorMapping(err);
  if (bodyError) {
    // Never log `err` itself: body-parser attaches the raw request body to
    // a parse failure (`err.body`), and a request body can carry PHI or
    // credentials. Only the error type and status are logged, at warn.
    requestLogger.warn(
      { bodyParserError: (err as { type?: string }).type ?? 'unreadable', status: bodyError.status },
      'Request body rejected',
    );
    const locale = resolveLocale(req.user?.locale, req.headers['accept-language']);
    const message = localizedErrorMessage(locale, bodyError.code, bodyError.message);
    res.status(bodyError.status).json({ message, code: bodyError.code });
    return;
  }

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
    const customIssue = err.issues.find(
      (issue) => (issue as unknown as { params?: { code?: string } }).params?.code,
    ) as unknown as { params?: { code?: string } } | undefined;
    const code = customIssue?.params?.code;
    const locale = resolveLocale(req.user?.locale, req.headers['accept-language']);
    const message = err.issues.map((issue) => issue.message).join('; ');
    const localized = code ? localizedErrorMessage(locale, code, message) : message;
    res.status(400).json(code ? { message: localized, code } : { message });
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
