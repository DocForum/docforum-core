Phase 9: per-request query budgets for list endpoints, catching N+1 queries
([issue #122](https://github.com/DocForum/docforum-core/issues/122)).
`backend/tests/helpers/query-budget.ts` runs a supertest request with a
test-only `X-Query-Count-Id`; `backend/src/db/query-count.ts` keeps that
request's Prisma operation count in an `AsyncLocalStorage`, so parallel tests
count separately, and a `$allOperations` extension on the shared client
increments it. `backend/tests/integration/query-budgets.test.mts` asserts a
constant budget at 1 and 50 rows for appointments (patient and doctor),
consultations (patient and doctor), referrals (patient and incoming), orders,
notifications, public doctor search and the pharmacy fulfillment queue. The
N+1 this found — `GET /referrals/mine` and `GET /referrals/incoming` writing
one `AccessLog` row per referral, 53 and 23 queries at 50 rows — is fixed with
`auditService.recordAccessMany`, one batched INSERT per page. No schema or
endpoint changes.
