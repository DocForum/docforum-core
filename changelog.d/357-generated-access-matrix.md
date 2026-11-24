Phase 9: the endpoint-by-role access matrix is generated from the routers
([issue #357](https://github.com/DocForum/docforum-core/issues/357)).
`backend/scripts/gen-access-matrix.ts` builds the app, recovers each router's
mount prefix by replaying `src/mounts.ts`, and reads every route's middleware
chain — roles come from calling `requireRole` once per role rather than parsing
it (the guard is an anonymous closure), plus `requireVerifiedEmail`,
`idempotencyMiddleware`, the auth middleware and any unrecognised guard.
Output is committed at `docs/api/access-matrix.md`; `npm run
docs:access-matrix:check` is a CI step, and `tests/unit/access-matrix.test.ts`
pins rows that were checked by hand against the route files. Docs-only and
test-only: no endpoint behaviour changes.
