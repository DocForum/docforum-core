Phase 8: security response headers and `X-Powered-By` removal
([issue #332](https://github.com/DocForum/docforum-core/issues/332)).
`backend/src/middleware/security-headers.ts`, registered in `createApp` right
after the request-id middleware, sets `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none';
frame-ancestors 'none'`, `X-Frame-Options: DENY` and `Cache-Control: no-store`
on every response (login/refresh carry tokens without an `Authorization`
header, so no-store isn't limited to authenticated requests; a route can
still set its own). `Strict-Transport-Security` is sent only when
`NODE_ENV=production` (`config.securityHeaders`), never in local development.
`x-powered-by` is disabled. Unmatched routes now answer a JSON
`404 { message: 'Not found.' }` instead of Express's HTML page, so the API
never serves HTML. The SSE stream keeps streaming with
`Cache-Control: no-store, no-transform`. No dependency added (no helmet).
Tests: `backend/tests/unit/security-headers.test.ts`,
`backend/tests/integration/security-headers.test.mts`.
