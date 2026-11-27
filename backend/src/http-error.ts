// Shared across modules — the one place an HTTP-status-bearing error is
// defined, so error-handler.ts has a single shape to check for.
//
// The code is required and comes from the catalogue (issue #115); the status
// is derived from it, so a code and its HTTP status can never drift apart.
// `message` stays in the envelope for backwards compatibility, but clients
// branch on `code` — messages are free to change.
import { ERROR_CATALOGUE, type ErrorCode } from './error-catalogue';

/** Structured, non-sensitive detail a client can act on (for example Zod
 * field failures). Never put PHI, secrets or internal identifiers here. */
export type ErrorDetails = Record<string, unknown>;

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetails;

  constructor(code: ErrorCode, message?: string, details?: ErrorDetails) {
    super(message ?? ERROR_CATALOGUE[code].message);
    this.name = 'HttpError';
    this.code = code;
    this.status = ERROR_CATALOGUE[code].status;
    this.details = details;
  }
}
