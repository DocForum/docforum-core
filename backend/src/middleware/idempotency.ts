// `Idempotency-Key` replay protection for money- and appointment-moving
// mutations (Phase 8, issue #48).
//
// The problem: a patient on mobile loses signal mid-request, sees a timeout,
// and retries. The backend cannot tell that retry from a deliberate second
// attempt, so the same tap books twice or funds twice. Worse, the fix cannot
// be "check then write" — two retries arriving 20 ms apart both pass the
// check. Booking already has to solve exactly this shape at the database
// level (ARCHITECTURE.md §5.1), and this is the same problem one layer up.
//
// The mechanism is deliberately the boring one: **the unique constraint on
// (userId, key) is the lock.** There is no in-memory mutex, no `Map`, no
// "pending requests" set in this process — every one of those is correct on
// one instance and silently broken on the second, and would also be lost on a
// restart, which is precisely when a retry storm arrives. Instead:
//
//   INSERT ... ON CONFLICT DO NOTHING (the unique index is (userId, key))
//     count 1 -> this request owns the attempt; run the handler and store
//                the response
//     count 0 -> someone else owns it; read the row and decide
//                  completed  -> replay the stored status/body/headers
//                  unfinished -> 409 IN_PROGRESS
//                  different  -> 422 (the key was reused for another request)
//                  stale      -> conditional takeover (below)
//
// Every one of those decisions is a single indexed read or a single
// conditional UPDATE, so two instances of this API behave identically to one.
//
// What is deliberately NOT here:
//   - No in-memory state, for the reason above.
//   - No 5xx caching. A server error is *not* a result — the request may or
//     may not have had side effects — so the row is deleted and the client is
//     expected to retry with the same key, which re-executes it. Caching a
//     500 would turn a transient failure into a permanent one for that key.
//   - No key reuse for a *different* request, even after a crash. A stale
//     unfinished row is only ever taken over by a request with the same hash
//     (the genuine retry); a different body on the same key is still 422,
//     because silently re-running a different operation under an old key is
//     how "I reused my key" turns into "I refunded the wrong payment".
//
// Scoping: keys are namespaced per user (`@@unique([userId, key])`) and every
// read filters on `userId`, so one account can neither replay nor read
// another account's stored response body — an `Idempotency-Key` is a guessable
// string, and treating it as a bearer credential would be a data leak.
//
// Storage note: the row holds a copy of a response the requesting user already
// received, kept only while a retry could still arrive (24 h by default, then
// `pruneIdempotencyKeys()` in src/server.ts). It is not patient data, is not an
// `AuditEvent`, and is deliberately not part of the patient-export bundle
// (ARCHITECTURE.md §4.12).
import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { config } from '../config';
import { HttpError } from '../http-error';
import { prisma } from '../db/prisma-client';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

// Machine-readable discriminators, matching the `code` field convention
// introduced by issue #34 so docforum-web can branch without parsing prose.
export const CODE_INVALID_KEY = 'INVALID_IDEMPOTENCY_KEY';
export const CODE_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED';
export const CODE_IN_PROGRESS = 'IN_PROGRESS';

// What a client should wait before repeating a request that collided with one
// already in flight. Short on purpose — the winner is usually a booking or an
// escrow call that finishes in seconds, and a retry is free.
export const RETRY_AFTER_SECONDS = 1;

// Bounded so a header can't be used as free storage in the table (a `key`
// column is indexed by (userId, key), and it is echoed back in logs).
const MAX_KEY_LENGTH = 255;
const ACCEPTABLE_KEY = /^[\x21-\x7e]{1,255}$/;

// A key must be non-empty, printable ASCII and bounded. This is not a secret
// (it is namespaced per user and never authenticates anything), it just has to
// be a stable, comparable token.
export function isValidIdempotencyKey(key: string): boolean {
  return key.length <= MAX_KEY_LENGTH && ACCEPTABLE_KEY.test(key);
}

/**
 * Deterministic JSON: object keys sorted, arrays left in order. The hash has to
 * match across processes and across JSON key ordering, otherwise the same
 * logical body sent twice could hash two ways and 422 against itself.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * What identifies "the same request" for replay purposes: the method, the
 * concrete path (so the same key aimed at a *different* `:id` is a mismatch,
 * not a replay of another record's response) and the body.
 */
export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method.toUpperCase()}\n${path}\n${canonicalJson(body)}`).digest('hex');
}

type Claim =
  /** Nobody had this key: this request owns the attempt. */
  | { kind: 'owned' }
  /** A completed attempt with the same key and the same body: send this back. */
  | { kind: 'replay'; status: number; body: unknown; location: string | null }
  /** Someone else's attempt is still running. */
  | { kind: 'in_progress' }
  /** The key exists but was used for a different request. */
  | { kind: 'mismatch' }
  /** Could not determine ownership within the retry budget — fail closed. */
  | { kind: 'unknown' };

// Bounded: each iteration is one indexed read or one conditional write, and
// every extra iteration needs two concurrent claims to have raced a deletion.
// Exhausting it means refusing, never double-running.
const CLAIM_ATTEMPTS = 3;

/**
 * Decides whether this request owns (userId, key), replays it, or is refused.
 *
 * The write that decides ownership is `createMany({ skipDuplicates: true })`,
 * i.e. `INSERT ... ON CONFLICT DO NOTHING` against the unique index: the
 * database returns "I inserted it" or "it was already there", atomically,
 * under concurrency. Application logic then only *reads* what the constraint
 * decided — the same division of labour as §5.1's `claimOpenSlot`.
 */
async function claimAttempt(params: {
  userId: string;
  key: string;
  method: string;
  route: string;
  requestHash: string;
  ttlMs: number;
  inProgressTimeoutMs: number;
}): Promise<Claim> {
  const expiresAt = new Date(Date.now() + params.ttlMs);

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const inserted = await prisma.idempotencyKey.createMany({
      data: [
        {
          userId: params.userId,
          key: params.key,
          method: params.method,
          route: params.route,
          requestHash: params.requestHash,
          expiresAt,
        },
      ],
      // The unique index is (userId, key) and the lookup below is by the same
      // pair, so "do nothing on conflict" and "select by" agree on which row
      // is the conflict.
      skipDuplicates: true,
    });

    if (inserted.count === 1) return { kind: 'owned' };

    const existing = await prisma.idempotencyKey.findUnique({
      where: { userId_key: { userId: params.userId, key: params.key } },
    });
    // Lost a race with a delete (expired row pruned between the two
    // statements). Loop and try the insert again rather than guessing.
    if (!existing) continue;

    // Past its TTL the key is free again: a retry this old is a new request,
    // not a replay of a forgotten one.
    if (existing.expiresAt.getTime() <= Date.now()) {
      await prisma.idempotencyKey.deleteMany({ where: { id: existing.id } });
      continue;
    }

    // Same key, different request. Checked BEFORE the staleness check below so
    // a takeover can never silently re-point an old key at a new operation.
    if (existing.requestHash !== params.requestHash) return { kind: 'mismatch' };

    if (existing.responseStatus !== null) {
      return {
        kind: 'replay',
        status: existing.responseStatus,
        body: existing.responseBody ?? null,
        location: readStoredLocation(existing.responseHeaders),
      };
    }

    // Unfinished, but old enough to be presumed dead: the process that owned it
    // died between claiming the key and storing a response. A *genuine* retry
    // (identical hash — already established above) may take it over. The UPDATE
    // repeats `responseStatus IS NULL` and the exact `createdAt` it read, so
    // two contenders still can't both win.
    if (Date.now() - existing.createdAt.getTime() >= params.inProgressTimeoutMs) {
      const takenOver = await prisma.idempotencyKey.updateMany({
        where: { id: existing.id, responseStatus: null, createdAt: existing.createdAt },
        data: {
          method: params.method,
          route: params.route,
          // Same hash by definition (checked above); restated so the row
          // describes the attempt that is actually running.
          requestHash: params.requestHash,
          createdAt: new Date(),
          expiresAt,
        },
      });
      if (takenOver.count === 1) return { kind: 'owned' };
      continue;
    }

    return { kind: 'in_progress' };
  }

  return { kind: 'unknown' };
}

function readStoredLocation(headers: unknown): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const value = (headers as Record<string, unknown>).location;
  return typeof value === 'string' ? value : null;
}

/**
 * Records the outcome of the attempt this request owns.
 *
 * A `5xx` deletes the row rather than caching it: see the header comment. Any
 * other status is stored, because for a 4xx the request *did* run and its
 * answer is the answer — replaying a deterministic "slot already booked" is
 * exactly what the client wants.
 */
async function settleAttempt(params: {
  userId: string;
  key: string;
  status: number;
  body: unknown;
  location: string | null;
}): Promise<void> {
  if (params.status >= 500) {
    await prisma.idempotencyKey.deleteMany({ where: { userId: params.userId, key: params.key } });
    return;
  }

  // Anything too large to be worth replaying is executed and then forgotten,
  // so a retry re-runs the request rather than getting a truncated body back.
  // (No current route comes close; this is a bound, not a policy.)
  const serialised = JSON.stringify(params.body ?? null);
  if (serialised.length > config.idempotency.maxCachedBodyBytes) {
    await prisma.idempotencyKey.deleteMany({ where: { userId: params.userId, key: params.key } });
    return;
  }

  await prisma.idempotencyKey.updateMany({
    where: {
      userId: params.userId,
      key: params.key,
      // Still ours and still unfinished: if the row was deleted (crash, prune)
      // or taken over while the handler ran, this write must not resurrect it.
      responseStatus: null,
    },
    data: {
      responseStatus: params.status,
      responseBody: JSON.parse(serialised),
      // Only `Location`, and never `Set-Cookie`: a replay must not re-issue a
      // credential, and no opted-in route sets one, but a future one must not
      // start doing so by accident.
      responseHeaders: params.location ? { location: params.location } : undefined,
    },
  });
}

/**
 * Express middleware factory. Opt-in per route:
 *
 *   router.post('/', authenticate, requireRole('patient'), idempotency(), book)
 *
 * The header is optional — a request without one passes through untouched, so
 * this can be mounted on a live route without breaking existing clients — but
 * every client that can retry should send one.
 */
export function idempotency() {
  return async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
    const raw = req.get(IDEMPOTENCY_HEADER);
    if (raw === undefined) return next();

    const key = raw.trim();
    if (!isValidIdempotencyKey(key)) {
      throw new HttpError(400, `\`${IDEMPOTENCY_HEADER}\` must be 1-${MAX_KEY_LENGTH} printable ASCII characters.`, CODE_INVALID_KEY);
    }
    if (!req.user) throw new HttpError(401, 'Authentication required.');

    // `req.baseUrl` is the router's mount path and `req.route.path` the
    // pattern under it, so the stored route reads '/payments/intents/:id/fund'
    // rather than a concrete URL — self-describing when debugging, and stable
    // across records. Collapsed and de-slashed ('/appointments' + '/' is the
    // same route as '/appointments'). The *hash* uses the concrete path (see
    // hashRequest).
    const pattern = typeof req.route?.path === 'string' ? req.route.path : req.path;
    const route = `${req.baseUrl}${pattern}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
    const path = `${req.baseUrl}${req.path}`;
    const requestHash = hashRequest(req.method, path, req.body);

    const claim = await claimAttempt({
      userId: req.user.id,
      key,
      method: req.method,
      route,
      requestHash,
      ttlMs: config.idempotency.recordTtlHours * 60 * 60 * 1000,
      inProgressTimeoutMs: config.idempotency.inProgressTimeoutSeconds * 1000,
    });

    if (claim.kind === 'mismatch') {
      throw new HttpError(
        422,
        'This Idempotency-Key was already used for a different request. Use a new key.',
        CODE_KEY_REUSED,
      );
    }
    if (claim.kind === 'in_progress' || claim.kind === 'unknown') {
      res.set('Retry-After', String(RETRY_AFTER_SECONDS));
      throw new HttpError(
        409,
        'A request with this Idempotency-Key is still in progress. Retry shortly with the same key.',
        CODE_IN_PROGRESS,
      );
    }
    if (claim.kind === 'replay') {
      res.set('Idempotency-Replayed', 'true');
      if (claim.location) res.set('Location', claim.location);
      res.status(claim.status).json(claim.body);
      return;
    }

    captureResponse(res, (body) =>
      settleAttempt({
        userId: req.user!.id,
        key,
        // Read at settle time: the controller has finished choosing a status.
        status: res.statusCode,
        body,
        // `Location` is read here rather than when the middleware started —
        // the controller sets it on the way out.
        location: res.get('Location') ?? null,
      }),
    );
    next();
  };
}

/**
 * Hooks `res.json` so the outcome of the handler we just released is stored
 * *before* the bytes go out.
 *
 * The write deliberately precedes the response. The alternative (fire-and-
 * forget after sending) loses the only durable record of what the client was
 * told whenever the process dies in between — which is exactly the retry
 * storm this exists for. Every opted-in controller answers with `res.json`,
 * including the shared error handler, so one hook covers both the success and
 * the failure path.
 */
function captureResponse(res: Response, settle: (body: unknown) => Promise<void>): void {
  let settled = false;
  const originalJson = res.json.bind(res);

  res.json = (body?: unknown) => {
    settled = true;
    void settle(body)
      .catch(() => {
        // Losing the cached response must not turn a successful mutation into
        // a failed request. The row stays unfinished, so a retry gets 409
        // until the crash-recovery timeout takes it over — an honest answer
        // for an unhappened outcome.
      })
      .then(() => originalJson(body));
    return res;
  };

  // Safety net: a handler that ends the response without `res.json`
  // (res.end, a bare res.send, a stream) leaves nothing to replay, so the
  // attempt is dropped instead of being stuck "in progress" for the whole
  // crash-recovery window.
  res.on('finish', () => {
    if (!settled) void settle(null);
  });
}

/**
 * Deletes rows whose TTL has passed. Called on an interval from src/server.ts,
 * same shape as the login-throttle prune (ARCHITECTURE_ESSENTIALS.md: plain
 * intervals, no queue, until a real job exists).
 *
 * Correctness does not depend on it: every lookup filters on `expiresAt`
 * first, so a row that outlives its TTL is invisible to replays either way.
 */
export async function pruneIdempotencyKeys(): Promise<number> {
  const result = await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}