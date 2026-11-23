---
file: docs/api/README.md
after: "Base URL: `http://localhost:4000` locally"
---

Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY` and `Cache-Control: no-store` (a route may override `Cache-Control`; the SSE stream sends `no-store, no-transform`). `Strict-Transport-Security` is sent in production only. `X-Powered-By` is not sent. An unknown route returns `404 { "message": "Not found." }`. Prisma not-found and foreign-key failures map to `404 Record not found.` and `422`, with generic messages that never name a table or constraint (issue #334). Issue #332.
