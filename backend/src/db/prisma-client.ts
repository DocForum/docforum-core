import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from '../config';

// Phase 8, issue #47: Prisma 7 dropped the Rust query engine — every client
// is now built on a driver adapter, and `new PrismaClient()` without one
// throws ("A driver adapter is required to connect to your database").
// PrismaPg wraps node-postgres, so the connection still comes from
// DATABASE_URL, exactly as it did through the v6 engine.
//
// Two settings below are deliberate, and both are about *behaviour parity*
// with Prisma 6 rather than new choices (see docs/adr/0006):
//   - connectionTimeoutMillis: node-pg defaults to no connect timeout (0),
//     where v6 waited 5s. Without this, a request against a wedged database
//     hangs indefinitely instead of failing fast after 5s.
//   - `ssl` is deliberately NOT passed. Render decides whether a given
//     DATABASE_URL uses TLS and expresses that in the URL itself; forcing an
//     `ssl` object here would break the internal (non-TLS) Render URL. The
//     v6→v7 certificate-validation change is a real deployment risk — if a
//     deploy logs `P1010: User was denied access on the database`, that is
//     it, and the documented remedy is `ssl: { rejectUnauthorized: false }`
//     (docs/adr/0003, docs/adr/0006).
const adapter = new PrismaPg({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 5_000),
  max: Number(process.env.DB_POOL_MAX ?? 5),
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 10_000),
});

// Single shared client for the whole process — Prisma's own guidance for
// a long-running server (as opposed to a new client per request/lambda).
//
// Phase 9, issue #48: query budget tests need to count queries *per request*.
// Prisma's `$on('query')` is process-global, so parallel supertest requests
// would otherwise pollute each other's counts. We expose a tiny per-request
// counter that the test helper can scope to a single request via
// `runWithQueryCounter` (AsyncLocalStorage), keeping the count isolated even
// when tests run concurrently. Production behaviour is unchanged: when no
// counter is active, the listener is a no-op.
export const prisma = new PrismaClient({ adapter });

export interface QueryCounter {
  count: number;
}

const queryCounterStorage = new AsyncLocalStorage<QueryCounter>();

// Attach a single process-wide listener that increments the counter active
// for the current async context, if any. Registering once avoids leaking
// listeners across tests.
prisma.$on('query', () => {
  const counter = queryCounterStorage.getStore();
  if (counter) counter.count += 1;
});

/**
 * Run `fn` with a fresh per-request query counter. The counter is scoped to
 * the async context of `fn`, so concurrent requests each get their own count.
 * Returns the result of `fn` alongside the number of Prisma queries executed.
 */
export async function runWithQueryCounter<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; queryCount: number }> {
  const counter: QueryCounter = { count: 0 };
  const result = await queryCounterStorage.run(counter, fn);
  return { result, queryCount: counter.count };
}
