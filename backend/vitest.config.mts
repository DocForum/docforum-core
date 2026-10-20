import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Booking-concurrency tests fire real concurrent transactions against
    // a real Postgres — a bit more headroom than vitest's 5s default.
    testTimeout: 15_000,
    // The integration beforeAll hooks do even more than one test: start an
    // embedded Postgres, run `prisma migrate deploy`, import the app and
    // seed actors. Several such files run in parallel, so on a loaded CI
    // runner the 10s default cut the hook off mid-seed (issue #39 CI run:
    // access-control timed out at 101 tests skipped).
    hookTimeout: 30_000,
    env: {
      JWT_ACCESS_SECRET: 'test-access-secret',
      JWT_REFRESH_SECRET: 'test-refresh-secret',
      // Port 5433, not 5432 — tests/integration/booking.test.mts spins up
      // its own throwaway Postgres cluster on this port so the suite is
      // self-contained (no pre-existing DB required). A distinct port
      // avoids clashing with a real local Postgres a developer may have
      // running on the default 5432.
      DATABASE_URL:
        process.env.DATABASE_URL_TEST ?? 'postgresql://docforum:docforum@localhost:5433/docforum_test',
    },
  },
});
