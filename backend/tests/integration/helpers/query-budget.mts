import { prisma } from '../../../src/db/prisma-client';
import supertest from 'supertest';

/**
 * Query budget helper (Phase 9, issue #48).
 *
 * Prisma makes N+1 queries easy to write (loop over appointments, fetch
 * each doctor). They pass every functional test and then blow the ~300ms
 * target once lists grow. This helper counts the queries Prisma actually
 * sends for a single supertest request, so the count becomes a tested
 * property of the endpoint.
 *
 * Why a per-request listener and not a global counter:
 *   - Prisma emits `query` events on the shared client. A global counter
 *     would include queries from parallel tests (Jest runs test files in
 *     parallel workers) and would flake. We attach a listener right before
 *     the request and detach it after the response resolves, counting only
 *     the queries that request caused.
 *   - The listener is awaited before detaching: Prisma emits `query`
 *     asynchronously, so a query that started during the request could land
 *     after the response. We give the event loop a tick to flush pending
 *     events before detaching.
 */

export interface QueryBudgetResult {
  /** Number of Prisma queries the request issued. */
  count: number;
  /** The supertest response, so callers can still assert on it. */
  response: supertest.Response;
  /** The query texts (for debugging a failing budget). */
  queries: string[];
}

/**
 * Run a supertest request and return how many Prisma queries it issued.
 *
 * Usage:
 *   const { count, response } = await measureQueries(
 *     request(app).get('/appointments/mine').set('Authorization', `Bearer ${token}`),
 *   );
 *   expect(count).toBeLessThanOrEqual(3);
 */
export async function measureQueries(request: supertest.Test): Promise<QueryBudgetResult> {
  const queries: string[] = [];

  // Prisma's `$'on('query')` callback receives the event object; the query
  // text lives on `e.query`. We keep the texts as well as the count so a
  // failing budget can report what actually ran.
  const listener = (e: { query: string }) => {
    queries.push(e.query);
  };

  // Prisma's typed event emitter is available on the client via `$on`.
  // The cast keeps this helper compatible with the generated client types.
  ( prisma as unknown as {
    $on: (event: 'query', cb: (e: { query: string }) => void) => void;
    $off: (event: 'query', cb: (e: { query: string }) => void) => void;
  } ).$on('query', listener);

  try {
    const response = await request;

    // Prisma emits `query` asynchronously. Yield one macrotask so any
    // query that started during the request but landed after the response
    // is counted before we detach.
    await new Promise((resolve) => setImmediate(resolve));

    return { count: queries.length, response, queries };
  } finally {
    ( prisma as unknown as {
      $off: (event: 'query', cb: (e: { query: string }) => void) => void;
    } ).$off('query', listener);
  }
}

/**
 * Assert that a request stayed within a query budget. Throws a message
 * that includes the queries that ran, so a failing budget is debuggable
 * without re-running the test.
 */
export async function expectQueryBudget(
  request: supertest.Test,
  budget: number,
  label?: string,
): Promise<QueryBudgetResult> {
  const result = await measureQueries(request);
  if (result.count > budget) {
    const prefix = label ? `${label}: ` : '';
    throw new Error(
      `${prefix}query budget exceeded (${result.count} > ${budget}). Queries:\n${result.queries.map((q) => `  - ${q}`).join('\n')}`,
    );
  }
  return result;
}
