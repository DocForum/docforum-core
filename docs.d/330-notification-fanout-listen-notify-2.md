---
file: docs/api/README.md
section: Notifications (`/notifications`) — `backend/src/modules/notifications`
---
`GET /notifications/stream` (issue #97) delivers to a user's streams on every
backend instance (issue #330). Events: `notification` with
`data: { id, type }` and `id:` set to the notification id (ids only, so fetch
the notification through `GET /notifications`); `resync` (no ids) when the
instance's fan-out listener has reconnected and events may have been missed,
so the client should refetch its inbox; and `token-expired`. `/health/ready`
reports the listener as `checks.notifications` without failing readiness.
