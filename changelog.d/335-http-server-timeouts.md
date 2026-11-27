Phase 8: HTTP server timeouts and a per-request deadline
([issue #335](https://github.com/DocForum/docforum-core/issues/335)).
`config.http` (`HTTP_KEEP_ALIVE_TIMEOUT_MS` = 305000, above Render's 5-minute
proxy idle timeout; `HTTP_HEADERS_TIMEOUT_MS` = 30000;
`HTTP_REQUEST_TIMEOUT_MS` = 120000) is applied to the Node server in
`src/server.ts` as `keepAliveTimeout`, `headersTimeout` and `requestTimeout`,
bounding slow-loris clients. `middleware/deadline.ts`, mounted in `app.ts`,
answers `503 REQUEST_TIMEOUT` when a non-streaming request has no response
after `HTTP_REQUEST_DEADLINE_MS` (30000); the SSE stream and the file
upload/download routes are exempt. The error handler now drops a late error
whose response was already sent. Unit tests in `tests/unit/deadline.test.ts`.
