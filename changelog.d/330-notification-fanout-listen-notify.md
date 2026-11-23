Phase 6: real-time notification events reach users on every backend instance
([issue #330](https://github.com/DocForum/docforum-core/issues/330)).
`notify()` now publishes through a broker
(`modules/notifications/services/fanout.ts`). The default broker uses
`pg_notify` on the `docforum_notifications` channel, and each instance
`LISTEN`s on its own connection outside Prisma's pool and delivers to its local
SSE streams. Payloads are ids only (`notificationId`, `userId`, `type`), and
clients fetch the notification over HTTP. The listener reconnects with
exponential backoff and sends each local stream a `resync` event afterwards.
Its state is reported, but not gated, as `checks.notifications` in
`/health/ready`. New settings: `NOTIFICATION_FANOUT_DRIVER` (`pg` | `local`),
`NOTIFICATION_FANOUT_RECONNECT_MIN_MS` and `NOTIFICATION_FANOUT_RECONNECT_MAX_MS`.
No schema changes.
