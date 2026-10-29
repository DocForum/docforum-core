// Optimistic concurrency for mutable records (Phase 8, issue #49).
// See ARCHITECTURE.md §5.4 for the convention every new module must follow.
//
// The whole point is that the compare and the write are ONE statement
// (`UPDATE ... WHERE id = ? AND version = ?` + `version = version + 1`).
// A read-compare-write would reopen the exact race this closes: two callers
// can both read version 4, both pass the check, and the second write
// silently destroys the first.
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../http-error';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      expectedVersion?: number;
    }
  }
}

/**
 * A weak validator (`W/"4"`) or a list (`"4", "7"`) is refused rather than
 * parsed: this API only ever issues one strong validator per resource, and
 * guessing which member of a list the caller meant is how silent overwrites
 * come back.
 */
const VERSION_ETAG = /^"([1-9]\d*)"$/;

/** Strong `ETag` carrying the row's integer version, e.g. `ETag: "4"`.
 * Call it on the individual-resource read; collection reads deliberately
 * don't get one (§5.4.5). */
export function setVersionEtag(res: Response, version: number) {
  res.set('ETag', `"${version}"`);
}

/** Rejects a mutable-resource write that doesn't carry the version it read.
 * Must run after `authenticate`/`requireRole` so an unauthorised caller gets
 * 401/403 rather than being told the resource exists. */
export function requireIfMatch(req: Request, _res: Response, next: NextFunction) {
  const value = req.get('If-Match');
  if (!value) {
    throw new HttpError(
      428,
      'If-Match is required. Read the resource first and retry with its ETag in the If-Match header.',
      'IF_MATCH_REQUIRED',
    );
  }

  const match = VERSION_ETAG.exec(value.trim());
  const version = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version)) {
    throw new HttpError(
      400,
      'If-Match must be the strong version ETag returned by this API, e.g. If-Match: "4".',
      'INVALID_IF_MATCH',
    );
  }

  req.expectedVersion = version;
  next();
}

/** The version the caller claimed. Read by a controller after
 * `requireIfMatch` has run; throws rather than defaulting to 0, because a
 * missing precondition silently skipping the guard would reintroduce the
 * lost-update bug this exists to prevent. */
export function expectedVersion(req: Request): number {
  const version = req.expectedVersion;
  if (typeof version !== 'number') {
    throw new Error('requireIfMatch must run before expectedVersion().');
  }
  return version;
}

/** The error a repository's zero-row conditional update means: someone else
 * moved the record since the caller read it. Shared so every module returns
 * the same status, message and code. */
export function versionConflict() {
  return new HttpError(
    412,
    'This record changed since you read it. Fetch it again and reapply your change.',
    'VERSION_CONFLICT',
  );
}