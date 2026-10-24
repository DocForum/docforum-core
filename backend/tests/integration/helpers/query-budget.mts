import { AsyncLocalStorage } from 'node:async_hooks';
import type { PrismaClient } from '@prisma/client';

/**
 * Per-request Prisma query counter.
 *
 * Prisma's `$parent.`query` event is global to the client, so a counter built on it
 * would leak across parallel tests. Instead we use `AsyncLocalStorage` to scope the
 * counter to the current async context (the supertest request). The counter is only
 * active while a budget measurement is in flight, so normal tests pay no cost.
 *
 * Usage:
 *   const { count } = await measureQueries(() => request(app).get('/appointments/mine'));
 *   expect(count).toBeLessThanOrEqual(3);
 */

type QueryCounter = { count: number };

const storage = new AsyncLocalStorage<QueryCounter>();

/**
 * Attach this once to the shared prisma client in test setup. It is idempotent:
 * calling it twice is a no-op.
 */
export function installQueryCounter(client: PrismaClient): void {
  const anyClient = client as unknown as {
    __queryBudgetInstalled?: boolean;
    $on: (event: 'query', cb: (e: { query: string }) => void) => void;
  };
  if (anyClient.__queryBudgetInstalled) return;
  anyClient.__queryBudgetInstalled = true;
  // Prisma emits this for every SQL statement it sends, regardless of which
  // model or repository called it. The counter is only incremented when a
  // measurement is active in the current async context.
  anyClient.$on('query', () => {
    const current = storage.getStore();
    if (current) current.count += 1;
  });
}

/**
 * Run `fn` with the query counter active for this async context only.
 * Returns the fn's result and the number of SQL statements issued while it ran.
 */
export async function measureQueries<T>(fn: () => Promise<T>): Promise<{ result: T; count: number }> {
  const counter: QueryCounter = { count: 0 };
  const result = await storage.run(counter, fn);
  return { result, count: counter.count };
}
