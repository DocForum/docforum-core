Phase 9: coverage reporting with per-module floors in CI
([issue #346](https://github.com/DocForum/docforum-core/issues/346)).
`npm run test:coverage` in `backend/` runs the unit and integration suites in
one vitest process with the v8 provider, so one report is the union of both —
appointments is 14.8% of lines under unit tests alone and 83.5% merged, which
is why a single process rather than two reports is the point — and it writes
`backend/coverage/` (html, `lcov.info`, `coverage-summary.json`), which CI
uploads as the `coverage-report` artifact on every run.
`vitest.config.mts` pins statements/functions/branches/lines floors for the
five correctness-critical modules (appointments, availability, referrals,
orders, payments) at the levels measured when this landed, minus two points of
runner slack, so coverage of one of them can no longer drop silently; every
other directory stays ungated so an unrelated PR can't fail on someone else's
coverage. The report counts every file under `src/`, including the ones no
test touches, which is what makes the issue's premise visible: `intake` sits
at 35.7% of lines, `src/modules/rate-limit` 17.7%, `src/jobs` 45.6%, and
`src/server.ts`, `src/pagination.ts` and `src/facility-hmac.ts` at 0%. Those
gaps need their own issues. Adds `@vitest/coverage-v8` as a devDependency, so
`backend/package-lock.json` records it and its istanbul deps. No schema,
endpoint or production-dependency changes.
