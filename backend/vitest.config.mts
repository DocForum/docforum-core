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
    // The end-to-end care-thread test walks every phase in one file,
    // so its hook also seeds the full actor set and needs headroom.
    hookTimeout: 120_000,
    env: {
      JWT_ACCESS_SECRET: 'test-access-secret',
      JWT_REFRESH_SECRET: 'test-refresh-secret',
      // SEP-10 (issue #77) — a throwaway keypair used ONLY by the test
      // suite; it holds no funds and exists to make the challenge/verify
      // code paths deterministic offline. Not a real deployment secret.
      SEP10_SIGNING_SECRET: 'SC3Z2YBPD7KGXC73CTBNDRGQOIUSAZUH445QIB2PPKWO7CXULRY75JGJ',
      SEP10_HOME_DOMAIN: 'docforum.test',
      SEP10_WEB_AUTH_DOMAIN: 'api.docforum.test',
      // Clinical free-text fields are encrypted at write time (issue #46).
      // A fixed 32-byte test key keeps ciphertext deterministic across runs
      // without touching the real key, which only production/dev envs hold.
      FIELD_ENCRYPTION_KEY_V1: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
      FIELD_ENCRYPTION_ACTIVE_VERSION: 'v1',
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
