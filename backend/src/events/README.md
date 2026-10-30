# Transactional Outbox

`publish(tx, type, payload)` validates and inserts an `OutboxEvent` using the
caller-provided Prisma transaction. Producers must call it inside the same
transaction as the domain change; the event is therefore present if and only
if that change commits. Never send email, SMS, or invoke event handlers inside
the producer's transaction.

The worker claims rows with `FOR UPDATE SKIP LOCKED`, then calls the registered
handler outside the claim transaction. Delivery is **at least once**: a process
can crash after a handler's side effect but before the event is marked
processed. Every handler must therefore be idempotent. The booking notification
handler uses `Notification.sourceEventId` as a unique idempotency key.

Failures retry with bounded exponential backoff. After five attempts the event
is marked `dead`; `lastError` stores only a stable error code, never an exception
message or event payload. Admins can inspect bounded dead-letter metadata at
`GET /admin/outbox/dead-letters`; payloads are never returned by that endpoint.

Register handlers before dispatch starts. Producers may publish only event
types and payloads in `eventPayloadSchemas`; add a schema and handler when adding
a new event.
