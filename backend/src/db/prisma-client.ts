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
  connectionTimeoutMillis: 5_000,
});

// Single shared client for the whole process — Prisma's own guidance for
// a long-running server (as opposed to a new client per request/lambda).
export const prisma = new PrismaClient({ adapter });
