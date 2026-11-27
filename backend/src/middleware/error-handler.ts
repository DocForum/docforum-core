import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { HttpError } from '../http-error';
import { ERROR_CATALOGUE, type ErrorCode } from '../error-catalogue';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../logger';
import { localizedErrorMessage, resolveLocale } from '../i18n';

/** Prisma known-request codes mapped to a coded client error (issue #334).
 * The messages are fixed strings: Prisma's own `message`/`meta` name tables,
 * columns and constraints, so they are logged server-side and never sent. */
export const PRISMA_CLIENT_ERRORS: Readonly<
  Record<string, { code: ErrorCode; message: string; log: string }>
> = {
  // Unique constraint failed.
  P2002: { code: 'DUPLICATE_RECORD', message: 'A record with this value already exists.', log: 'Unique constraint violation' },
  // Foreign key constraint failed: the request names a record that doesn't
  // exist (create/update), or one that other records still depend on.
  P2003: {
    code: 'INVALID_REFERENCE',
    message: 'The request refers to a record that does not exist or is still in use.',
    log: 'Foreign key constraint violation',
  },
  // An update/delete (or a required connect) matched no row.
  P2025: { code: 'NOT_FOUND', message: 'Record not found.', log: 'Record not found' },
};

/**
 * Issue #333: body-parser (express.json()) failures are client errors, not
 * 500s. Each `type` maps to a stable catalogue code (which fixes the status).
 * Routes with their own body handling (the lab-result raw-body route) convert
 * these errors to their own HttpError first, so their codes are kept.
 */
const BODY_PARSER_ERRORS: Record<string, { code: ErrorCode; message: string }> = {
  'entity.parse.failed': { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' },
  'entity.too.large': { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' },
  'encoding.unsupported': { code: 'UNSUPPORTED_ENCODING', message: 'The request body encoding is not supported.' },
  'charset.unsupported': { code: 'UNSUPPORTED_CHARSET', message: 'The request body charset is not supported.' },
  'request.aborted': { code: 'REQUEST_ABORTED', message: 'The request body was not fully received.' },
  'request.size.invalid': { code: 'INVALID_REQUEST_BODY', message: 'The request body could not be read.' },
};

// A corrupt compressed body (e.g. `Content-Encoding: gzip` with bytes that
// aren't gzip) surfaces from body-parser as an http-errors 400 with NO
// `type`. It is the same client mistake, so it gets the same treatment.
const UNREADABLE_BODY = { code: 'INVALID_REQUEST_BODY' as const, message: 'The request body could not be read.' };

/** Returns the mapping for a body-parser error, or undefined for anything
 * else. Exported for unit tests. */
export function bodyParserErrorMapping(err: unknown) {
  if (typeof err !== 'object' || err === null || err instanceof HttpError) return undefined;
  const { type, status, expose } = err as { type?: unknown; status?: unknown; expose?: unknown };
  if (typeof type === 'string') return Object.hasOwn(BODY_PARSER_ERRORS, type) ? BODY_PARSER_ERRORS[type] : undefined;
  return status === 400 && expose === true ? UNREADABLE_BODY : undefined;
}

// docforum-web's api-client.ts assumes the error envelope carries
// `{ code, message }` (documented as unconfirmed there) — this is the
// implementation that assumption is checked against. Keep them in sync.
//
// Every response carries a code (issue #115). `message` is the human-readable
// text kept for backwards compatibility; clients must branch on `code`.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestLogger: Logger =
    (req as Request & { log?: Logger }).log ?? rootLogger;

  // The response already went out (e.g. the request deadline answered 503
  // while the handler was still running, issue #335): log it, write nothing.
  if (res.headersSent) {
    requestLogger.warn({ err }, 'Request failed after its response was sent');
    return;
  }

  const bodyError = bodyParserErrorMapping(err);
  if (bodyError) {
    // Never log `err` itself: body-parser attaches the raw request body to
    // a parse failure (`err.body`), and a request body can carry PHI or
    // credentials. Only the error type and status are logged, at warn.
    const status = ERROR_CATALOGUE[bodyError.code].status;
    requestLogger.warn(
      { bodyParserError: (err as { type?: string }).type ?? 'unreadable', status },
      'Request body rejected',
    );
    const locale = resolveLocale(req.user?.locale, req.headers['accept-language']);
    const message = localizedErrorMessage(locale, bodyError.code, bodyError.message);
    res.status(status).json({ code: bodyError.code, message });
    return;
  }

  if (err instanceof HttpError) {
    if (err.status >= 500) {
      requestLogger.error({ err }, 'Request failed');
    } else {
      requestLogger.warn({ err }, 'Request rejected');
    }
    const locale = resolveLocale(req.user?.locale, req.headers['accept-language']);
    const message = localizedErrorMessage(locale, err.code, err.message);
    res.status(err.status).json(
      err.details ? { code: err.code, message, details: err.details } : { code: err.code, message },
    );
    return;
  }

  // Schema validation failures share one top-level code (`VALIDATION_FAILED`);
  // the per-field detail carries the specific validation code so a client can
  // still tell a short password from a malformed date.
  if (err instanceof ZodError) {
    requestLogger.warn({ err }, 'Request validation failed');
    const locale = resolveLocale(req.user?.locale, req.headers['accept-language']);
    const message = err.issues.map((issue) => issue.message).join('; ');
    const fields = err.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: (issue as unknown as { params?: { code?: string } }).params?.code ?? issue.code,
      message: issue.message,
    }));
    res.status(ERROR_CATALOGUE.VALIDATION_FAILED.status).json({
      code: 'VALIDATION_FAILED' as const,
      message: localizedErrorMessage(locale, 'VALIDATION_FAILED', message),
      details: { fields },
    });
    return;
  }

  // Prisma request errors that are the client's fault (issue #334). Errors
  // thrown inside `$transaction` reach here as the same class, so they map
  // the same way.
  const prismaMapping = err instanceof Prisma.PrismaClientKnownRequestError ? PRISMA_CLIENT_ERRORS[err.code] : undefined;
  if (prismaMapping) {
    requestLogger.warn({ err }, prismaMapping.log);
    const status = ERROR_CATALOGUE[prismaMapping.code].status;
    res.status(status).json({ code: prismaMapping.code, message: prismaMapping.message });
    return;
  }

  // Log the full error (including stack) server-side only. The response
  // body is the safe envelope and never leaks internal details.
  requestLogger.error({ err }, 'Unhandled error');
  res.status(ERROR_CATALOGUE.INTERNAL.status).json({ code: 'INTERNAL', message: 'Internal server error.' });
}
