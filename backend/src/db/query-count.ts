// Per-request Prisma query counting (issue #122).
//
// Prisma makes N+1 easy: a `findMany` plus a `findUnique` per row passes every
// functional test and only shows up as latency once a list grows. This module
// turns "how many queries did this request run?" into something a test can
// assert on, which is what `tests/helpers/query-budget.ts` and the
// `query-budgets` integration suite use.
//
// Why a counter keyed by a header instead of a single global number: parallel
// test files (and parallel requests inside one file) would otherwise add their
// queries together, and the budget assertion would be meaningless. The test
// helper sends `X-Query-Count-Id`, this middleware opens a counter for that id
// and runs the rest of the request inside `AsyncLocalStorage`, and the Prisma
// extension in `prisma-client.ts` increments whichever counter the current
// async context points at. Two concurrent requests therefore count separately
// even on the one shared Prisma client.
//
// Gated to non-production and to requests that opt in with the header, so a
// production request never pays more than one `req.get` call; without the
// header nothing is stored and `recordQuery` is a no-op.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

/** Opt-in marker. Deliberately a test-only header, not a query parameter. */
export const QUERY_COUNT_HEADER = 'x-query-count-id';

export interface QueryCounter {
  count: number;
}

const counterContext = new AsyncLocalStorage<QueryCounter>();
const counters = new Map<string, QueryCounter>();

/** Called by the Prisma query extension once per model operation. */
export function recordQuery(): void {
  const counter = counterContext.getStore();
  if (counter) counter.count += 1;
}

/**
 * Opens a counter for a request that carries `X-Query-Count-Id` and runs the
 * rest of that request inside it. Inert everywhere else.
 *
 * The counter is kept in a registry (not only in `res.locals`) because the
 * test helper reads it after the response has finished, when the request's
 * async context is gone.
 */
export function queryCountMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV === 'production') {
    next();
    return;
  }
  const id = req.get(QUERY_COUNT_HEADER);
  if (!id) {
    next();
    return;
  }
  const counter: QueryCounter = { count: 0 };
  counters.set(id, counter);
  res.on('close', () => {
    // The helper `take`s the counter first; this only sweeps ids whose test
    // never read them, and `unref` keeps it from holding the process open.
    const timer = setTimeout(() => counters.delete(id), 30_000);
    timer.unref();
  });
  counterContext.run(counter, next);
}

/**
 * Returns (and forgets) the query count for `id`, or `undefined` when no
 * counter was ever opened — which also tells the helper the middleware is not
 * mounted, instead of silently asserting against zero.
 */
export function takeQueryCount(id: string): number | undefined {
  const counter = counters.get(id);
  if (!counter) return undefined;
  counters.delete(id);
  return counter.count;
}
