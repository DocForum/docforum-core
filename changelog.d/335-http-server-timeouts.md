Phase 8, issue #335: HTTP server timeouts against slow clients

Server-level HTTP timeouts configured from environment:

- `keepAliveTimeout` (default 300_000ms / 5 minutes): above Render's proxy idle timeout of 5 minutes.
- `headersTimeout` (default 30_000ms / 30 seconds): ensures headers are not held indefinitely.
- `requestTimeout` (default 120_000ms / 2 minutes): per-request deadline for normal API routes.

A new `deadlineMiddleware` (`src/middleware/deadline.ts`) exempts SSE stream (`/notifications/stream`)
and lab-result upload (`/lab-results`) from per-request deadlines, and returns `503` with code
`REQUEST_TIMEOUT` when a non-exempt request exceeds the configured `requestTimeout`.

The server (`src/server.ts`) sets `keepAliveTimeout`, `headersTimeout`, and `requestTimeout` on the
Node HTTP server after listening, since Express `app.listen` options are only accepted during the listen
call. Per-request socket timeout enforcement is handled by the middleware.

Closes #335