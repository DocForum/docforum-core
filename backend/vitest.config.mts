import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      {
        // Every integration file connects as a non-superuser owner, like a
        // managed host's account. A superuser would skip RLS (docs/adr/0014).
        find: /^embedded-postgres$/,
        replacement: fileURLToPath(new URL('./tests/helpers/restricted-embedded-postgres.mts', import.meta.url)),
      },
    ],
  },
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
      // Legacy integration fixtures run as the explicit maintenance role
      // unless a test supplies a request identity with runWithRlsContext.
      RLS_TEST_BYPASS: '1',
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
      // Lab result files (issue #16) go to an in-process store in tests; the
      // S3 driver is the deployed one (docs/adr/0018).
      OBJECT_STORAGE_DRIVER: 'memory',
      // Port 5433, not 5432 — tests/integration/booking.test.mts spins up
      // its own throwaway Postgres cluster on this port so the suite is
      // self-contained (no pre-existing DB required). A distinct port
      // avoids clashing with a real local Postgres a developer may have
      // running on the default 5432.
      DATABASE_URL:
        process.env.DATABASE_URL_TEST ?? 'postgresql://docforum:docforum@localhost:5433/docforum_test',
    },
    coverage: {
      provider: 'v8',
      // Every source file is measured, not only the ones a test imported —
      // the point of the report is that an untested path shows as 0% instead
      // of being missing from the table (issue #346).
      include: ['src/**/*.ts'],
      // text for the terminal, lcov + json-summary for CI and scripts, html
      // so a contributor can browse the report from the artifact.
      reporter: ['text', 'lcov', 'json-summary', 'html'],
      // Unit and integration coverage are collected by the same vitest
      // process (see `npm run test:coverage`), so one coverage map covers
      // both suites — no cross-run merge to get wrong.
      //
      // Floors for the correctness-critical modules (issue #346). Each floor is
      // the measurement below rounded down to a whole percent, minus 2 points, so
      // a V8 or timing difference between a dev machine and the CI runner can't
      // fail an unrelated PR. Measured with `npm run test:coverage` on the
      // `bce31cc` tree this sits on (119 test files, 1173 tests, exit 0). These
      // are CI's own numbers, read out of the `coverage-report` artifact from the
      // green `Backend` run of this branch, and they match a local arm64 run to the
      // hundredth on seventeen of the twenty (the three apart are payments, by at
      // most 0.16):
      //
      //   module         statements  functions  branches  lines   floor s/f/b/l
      //   appointments       77.28       86.67     60.79   83.50     75/84/58/81
      //   availability       92.80      100.00     83.56   94.74     91/98/82/92
      //   referrals          90.21      100.00     81.05   96.22     88/98/79/94
      //   orders             86.03       90.82     75.95   90.05     84/88/74/88
      //   payments           79.38       91.16     70.53   83.35     77/89/68/81
      //
      // That is a snapshot, not a live total — re-measure before changing a
      // number. Appointments is up from 75.95 / 85.33 / 58.63 / 82.27 on `4a8cfbf`
      // because `#419` landed the doctor day-view and status-transition suite, so
      // its floor went up with it; that is the only direction this comment allows.
      // Four green merged runs sit behind the table: two on `7f70e1b` (279.08s and
      // 188.42s, both at 3 workers), one here at the default count, and CI's. The
      // only number that moves between *green* runs of the *same* tree is payments —
      // 79.26 / 70.37 / 83.23 against the 79.38 / 70.53 / 83.35 tabled here, a
      // spread of 0.16 that also happens to be the local-vs-CI difference. The
      // other two moved when the base moved: availability read 93.60 / 84.93 on
      // `7f70e1b` and is 92.80 / 83.56 here with no change to any file in its own
      // module (`#408` reworked `server.ts` and the Prisma schemas, so which of
      // its lines execute shifted), and referrals moved to 90.21 / 81.05 / 96.22.
      // Every floor is under every measurement its own module has produced on
      // either tree, so this movement cannot turn a green run red by itself; the
      // tightest gap is 1.56 (availability branches) and the loosest 2.82 (orders
      // functions). Two floors are not exactly "measurement minus 2" and both err
      // the same way: availability keeps the 91/82 that its higher `7f70e1b`
      // measurement earned rather than the 90/81 this run would give, and orders'
      // branch floor is 1.95 under 75.95 because that rounds up to 76. A floor is
      // never lowered to meet a dip.
      //
      // The gate is live, not decorative. Raising appointments' `lines` floor one
      // point above its own measurement (80 → 84, against 82.27) produced exactly
      // one error and nothing else: `ERROR: Coverage for lines (82.26%) does not
      // meet "src/modules/appointments/**" threshold (84%)`, with the same test
      // files passing and exit 1. As committed, the merged run exits 0 with all 119
      // files green and no threshold error — locally and in CI's
      // `Coverage (unit + integration, merged)` step on this branch.
      //
      // One interaction to know about: these floors assume a green suite. On a run
      // where a module's own test file fails, that file's lines go uncovered and
      // the module measures lower — with `orders.test.mts` among 3 files failing,
      // orders' lines came out at 87.90% against its 88 floor and reported
      // `ERROR: Coverage for lines (87.9%) does not meet "src/modules/orders/**"
      // threshold (88%)`; a later run with one referrals integration file failing
      // measured referrals at 89.95 / 80.65 / 95.93 instead of 90.21 / 81.05 / 96.22.
      // That only surfaces if you pass `--coverage.reportOnFailure` (vitest
      // otherwise prints no table for a failing run), and the run was already
      // exiting 1 on the test failure, so it is noise rather than a second gate —
      // but it is why the floors are not set tighter than 2 points.
      //
      // Worker counts are not a fix for the suite's own flakiness, which is
      // load-dependent and lands in a different file each run: locally, plain
      // `npm run test:integration` fails at both 7 and 3 workers (and CI's runs of
      // that step on `main` are green, so it reads as a loaded dev machine rather
      // than a broken suite). No count is tuned for here.
      //
      // Only these directories are gated: a global threshold would make
      // every unrelated PR fail on someone else's coverage. Raise a number
      // when its module genuinely improves; never lower one to go green.
      // The floors assume both suites — `--coverage` on `tests/unit` alone
      // fails them by design, since most of these paths are only reached
      // over HTTP.
      thresholds: {
        'src/modules/appointments/**': { statements: 75, functions: 84, branches: 58, lines: 81 },
        'src/modules/availability/**': { statements: 91, functions: 98, branches: 82, lines: 92 },
        'src/modules/referrals/**': { statements: 88, functions: 98, branches: 79, lines: 94 },
        'src/modules/orders/**': { statements: 84, functions: 88, branches: 74, lines: 88 },
        'src/modules/payments/**': { statements: 77, functions: 89, branches: 68, lines: 81 },
      },
    },
  },
});
