Phase 6: real-time notification stream over Server-Sent Events
([issue #97](https://github.com/DocForum/docforum-core/issues/97), partial).
`GET /notifications/stream` (authenticated) sends a `retry` hint, a heartbeat
every 15 seconds, and a `token-expired` event before the access token expires,
then closes. Each user is capped at five open streams (429 beyond that). An
in-process hub fans out events to the user's streams. Persisted replay via
`Last-Event-ID` and cross-instance delivery through Postgres LISTEN/NOTIFY are
not included. They need the `Notification.userId` schema field.
