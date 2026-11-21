Tests: integration files that share an embedded Postgres `const PORT` no
longer time out when vitest runs them in parallel. The test wrapper
(`backend/tests/helpers/restricted-embedded-postgres.mts`) holds a per-port
lock from `start()` to `stop()`, so the second file waits a few seconds for
the first instead of failing with "Hook timed out". Existing test files need
no changes; distinct ports are still preferred because they're faster.
