Phase 6: integration tests for `GET /notifications/stream`
([issue #331](https://github.com/DocForum/docforum-core/issues/331)).
`backend/tests/integration/notification-stream.test.mts` opens real SSE
connections against `createApp()` and covers 401 (missing/invalid token), the
stream headers and retry hint, heartbeats, delivery of a published event to
the recipient's streams only, the exact per-user cap (5 open, 6th is
`429 STREAM_LIMIT`, closing one frees exactly one slot, other users
unaffected), the `token-expired` event ending the stream, and unsubscribe on
client disconnect. Every connection is destroyed in `afterEach` and the hub
count is awaited back to zero. The heartbeat interval is now
`streamTimings.heartbeatMs` (still 15s) so the test can shorten it; the suite
runs in about 4s. No schema or endpoint changes.
