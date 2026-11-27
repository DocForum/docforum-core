Phase 9: `backend/.env.example` now documents every environment variable the
backend reads, grouped by module with a one-line comment and a safe default
or placeholder; the test-only `RLS_TEST_BYPASS` is marked as such
([issue #344](https://github.com/DocForum/docforum-core/issues/344)).
`npm run check:env` (`backend/scripts/check-env-parity.mjs`, run in CI) fails
when `src/` reads a variable with no `NAME=` line (commented-out lines count)
in `.env.example`. Names built at runtime, such as `JWT_${prefix}_SECRET`,
are not detectable and are documented by hand. No schema or endpoint changes.
