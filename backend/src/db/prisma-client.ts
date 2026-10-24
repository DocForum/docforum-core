import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from '../config';
import { AsyncLocalStorage } from 'node:async_hooks';

export type RlsRequestContext = { userId: string; role: string };
const rlsContext = new AsyncLocalStorage<RlsRequestContext>();
const inRlsTransaction = new AsyncLocalStorage<boolean>();

/** Keep the authenticated identity available to the RLS query extension. */
export function runWithRlsContext<T>(context: RlsRequestContext, callback: () => T): T {
  return rlsContext.run(context, callback);
}

/** Run trusted maintenance work under the dedicated database bypass role. */
export async function withRlsBypass<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return extendedClient.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE docforum_rls_bypass`;
    return inRlsTransaction.run(true, () => callback(tx as unknown as Prisma.TransactionClient));
  });
}

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

// Patient-owned rows are protected by PostgreSQL RLS. The query extension
// batches the context setup and protected operation in one transaction. SET
// LOCAL semantics are provided by set_config(..., true), so pooled sessions
// cannot retain a previous request's identity.
const rlsExtension = Prisma.defineExtension((client) => client.$extends({
  name: 'patient-row-level-security',
  query: {
    $allModels: {
      async $allOperations({ model, args, query }) {
        if (model !== 'Appointment' && model !== 'PaymentIntent' && model !== 'Consultation') return query(args);
        return withRlsVariables(client, args, query);
      },
    },
  },
}));

async function withRlsVariables<TArgs, TResult>(
  client: any,
  args: TArgs,
  query: (args: TArgs) => Promise<TResult>,
): Promise<TResult> {
  // Interactive transactions install the context once before invoking their
  // callback. Do not start a nested transaction for each model operation.
  if (inRlsTransaction.getStore()) return query(args);
  // Queries outside an HTTP request (for example, an accidentally unscoped
  // background task) get an empty identity and therefore no patient rows.
  // Trusted jobs must opt into withRlsBypass explicitly.
  const context = rlsContext.getStore();
  const testBypass = !context && process.env.RLS_TEST_BYPASS === '1';
  const identity = context ?? { userId: '', role: 'anonymous' };
  const [, , result] = await client.$transaction([
    testBypass
      ? client.$executeRaw`SET LOCAL ROLE docforum_rls_bypass`
      : client.$executeRaw`SET LOCAL ROLE docforum_app`,
    client.$executeRaw`SELECT set_config('app.current_user_id', ${identity.userId}, true), set_config('app.current_role', ${identity.role}, true)`,
    query(args) as Prisma.PrismaPromise<TResult>,
  ] as [Prisma.PrismaPromise<number>, Prisma.PrismaPromise<number>, Prisma.PrismaPromise<TResult>]);
  return result;
}

// Single shared client for the whole process — Prisma's own guidance for
// a long-running server (as opposed to a new client per request/lambda).
const extendedClient = new PrismaClient({ adapter }).$extends(rlsExtension);

// Set context once at the start of every request-owned interactive
// transaction. This keeps booking's conditional slot claim and appointment
// insert in their original transaction and avoids per-query overhead there.
export const prisma = new Proxy(extendedClient, {
  get(target, property, receiver) {
    if (property !== '$transaction') return Reflect.get(target, property, receiver);
    return async (arg: unknown, options?: unknown) => {
      if (typeof arg !== 'function') return (target.$transaction as (a: unknown, o?: unknown) => Promise<unknown>)(arg, options);
      const context = rlsContext.getStore();
      const testBypass = !context && process.env.RLS_TEST_BYPASS === '1';
      const identity = context ?? { userId: '', role: 'anonymous' };
      return target.$transaction(async (tx) => {
        if (testBypass) await tx.$executeRaw`SET LOCAL ROLE docforum_rls_bypass`;
        else await tx.$executeRaw`SET LOCAL ROLE docforum_app`;
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${identity.userId}, true), set_config('app.current_role', ${identity.role}, true)`;
        return inRlsTransaction.run(true, () => (arg as (tx: Prisma.TransactionClient) => unknown)(tx as unknown as Prisma.TransactionClient));
      }, options as never);
    };
  },
}) as unknown as PrismaClient;
