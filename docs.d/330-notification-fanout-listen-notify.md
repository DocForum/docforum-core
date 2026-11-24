---
file: ARCHITECTURE.md
section: 4.8 Notifications
---
Real-time fan-out across instances (issue #330): the SSE hub only holds the
streams open on its own process, so `notify()` publishes every newly created
notification through a broker (`modules/notifications/services/fanout.ts`).
The default broker sends `pg_notify('docforum_notifications', …)` on the shared
pool. Each instance `LISTEN`s on a dedicated node-postgres connection outside
Prisma's pool (`createListenerConnection` in `src/db/prisma-client.ts`, started
only from `src/server.ts`) and delivers to its local streams. Delivery is
single-path: the publishing instance receives its own NOTIFY rather than also
delivering locally, so nothing is sent twice. The NOTIFY payload and the SSE
`notification` frame carry ids only (`notificationId`/`id`, `userId`, `type`),
well under the 8000-byte limit, and clients fetch the row over HTTP. Real-time
is best-effort: the listener reconnects with exponential backoff, events
NOTIFYed while it was down are lost to that instance, and every local stream
gets a `resync` event after a reconnect so the client refetches its inbox.
The listener state (`listening | connecting | reconnecting | stopped | local`)
is reported as `checks.notifications` in `/health/ready` but does not gate
readiness. `NOTIFICATION_FANOUT_DRIVER=local` keeps delivery in-process.
