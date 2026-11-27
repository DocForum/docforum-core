// Supertest helper for issue #122: count the Prisma queries one request runs.
//
// Usage (see tests/integration/query-budgets.test.mts):
//
//   const { response, queries } = await measureQueries(app, (agent) =>
//     agent.get('/appointments/mine').set('Authorization', `Bearer ${token}`),
//   );
//   expect(queries).toBeLessThanOrEqual(APPOINTMENTS_MINE_BUDGET);
//
// The count is per request, not global: each call tags its request with a
// unique `X-Query-Count-Id`, and the middleware in `src/db/query-count.ts`
// keeps that request's queries in their own AsyncLocalStorage counter, so
// parallel tests can call this at the same time without interfering.
//
// Budgets must be constant in result size. Measure the same endpoint at 1 row
// and at 50 rows: a number that grows with the fixture is an N+1, not a budget.
import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import { QUERY_COUNT_HEADER, takeQueryCount } from '../../src/db/query-count.js';

export interface MeasuredResponse {
  response: request.Response;
  queries: number;
}

let sequence = 0;

export function nextQueryCountId(): string {
  sequence += 1;
  return `query-count-${process.pid}-${Date.now()}-${sequence}`;
}

/**
 * Runs `build(agent)` as a supertest request carrying a fresh count id and
 * returns the response together with how many Prisma operations it ran.
 */
export async function measureQueries(
  app: Express,
  build: (agent: ReturnType<typeof request>) => request.Test,
): Promise<MeasuredResponse> {
  const id = nextQueryCountId();
  const test = build(request(app));
  test.set(QUERY_COUNT_HEADER, id);
  const response = await test;

  // Audit records are written fire-and-forget (`void prisma...create()`), so a
  // per-row write loop is issued during the handler but may finish after the
  // response. Let the microtask queue and one macrotask turn drain before
  // reading the counter, so those writes are still attributed to this request.
  await new Promise<void>((resolve) => setImmediate(resolve));

  const queries = takeQueryCount(id);
  if (queries === undefined) {
    throw new Error(
      'No query count was recorded. Is queryCountMiddleware mounted in createApp(), and was the request made through measureQueries()?',
    );
  }
  return { response, queries };
}

/**
 * `measureQueries` plus a budget assertion. The message names the endpoint and
 * both numbers, so a failing run reads as "GET /x ran 51 queries, budget 3"
 * rather than a bare inequality.
 */
export async function expectQueryBudget(
  app: Express,
  build: (agent: ReturnType<typeof request>) => request.Test,
  budget: number,
): Promise<MeasuredResponse> {
  const measured = await measureQueries(app, build);
  const { response, queries } = measured;
  expect(
    queries,
    `${response.request.method} ${response.request.url} ran ${queries} Prisma queries, budget ${budget}. ` +
      'A count that grows with the result set is an N+1: batch the per-row read into one query (or a module service that does).',
  ).toBeLessThanOrEqual(budget);
  return measured;
}
