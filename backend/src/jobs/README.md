# jobs

Background jobs (reminders, order-expiry checks, notification delivery).

Per ARCHITECTURE_ESSENTIALS.md: keep this simple (cron/interval) until a
real job exists — do not introduce a queue (e.g. BullMQ/Redis) preemptively.
See ARCHITECTURE.md §6.3.2 for the overengineering flag on this exact point.

Jobs are started from `src/server.ts` only, never from `app.ts`, so test
suites that build the app don't start timers. Each job is a thin scheduler
around a module's service function; the state transitions themselves are
conditional UPDATEs in that module, so running more than one process is
safe.

| Job | File | What it does |
|---|---|---|
| Login-throttle prune (issue #35) | `src/server.ts` | Deletes stale `LoginAttempt` buckets. |
| Patient-export worker (issue #40) | `patient-exports.ts` | Generates pending exports one at a time; woken immediately by a new request, plus every `PATIENT_EXPORT_WORKER_INTERVAL_SECONDS`. Requeues claims older than `PATIENT_EXPORT_STALE_AFTER_SECONDS` (up to `PATIENT_EXPORT_MAX_ATTEMPTS`). |
| Patient-export cleanup (issue #40) | `patient-exports.ts` | Every `PATIENT_EXPORT_CLEANUP_INTERVAL_SECONDS`: expires `ready` exports past `expiresAt` and deletes their chunks, plus any chunk that can never be served. |
| Transactional outbox (issue #94) | `outbox-events.ts` | Every 5 seconds, claims due events with `FOR UPDATE SKIP LOCKED`, calls handlers at least once, and retries with bounded exponential backoff; after five attempts events are dead-lettered. Also the durable queue for automatic payment settlement (issues #83/#84): `order.fulfilled` releases, `order.rejected`/`order.expired` refund. |
| Deleted-account purge (issue #41, ADR 0010) | `account-purge.ts` | Every `ACCOUNT_PURGE_INTERVAL_SECONDS`: hard-deletes anonymised patients that no module holds records for (`src/retention-holds.ts`), once `ACCOUNT_PURGE_GRACE_HOURS` has passed. Never deletes clinical, order or payment rows. Logs counts and error types only. |
| Prepared-payment expiry (issue #80) | `payment-intents.ts` | Every `PAYMENT_PREPARE_EXPIRY_SWEEP_INTERVAL_SECONDS` (default 60): moves `PaymentIntent`s stuck in `awaiting_signature` past their `preparedExpiresAt` back to `created`, clearing the prepared transaction. Expiry is a normal case — the patient prepares again. |
| Lab-result escalation (issue #72) | `lab-result-escalation.ts` | Every `LAB_RESULT_ESCALATION_SWEEP_SECONDS` (default 300), and once at startup: marks overdue unacknowledged abnormal/critical results as escalated with one conditional UPDATE, so an acknowledgement that wins the race is never escalated. A missed tick is visible because the admin queue derives `overdue` from the deadline. |
| Lab-order expiry (issue #12/#84) | `lab-order-expiry.ts` (scheduled in `server.ts`) | Hourly: moves `issued` lab orders past `expiresAt` to `expired` with a conditional UPDATE and publishes `order.expired` in the same transaction, which the outbox worker turns into an automatic escrow refund. Batched by id keyset since issue #348 (`EXPIRY_SWEEP_BATCH_SIZE`, `EXPIRY_SWEEP_MAX_PER_RUN`); leftovers go to the next tick. |
| Unconfirmed-order expiry (issue #76) | `order-expiry.ts` | Every `ORDER_EXPIRY_INTERVAL_SECONDS`: auto-confirms fulfilled, unconfirmed, undisputed orders past `ORDER_CONFIRMATION_WINDOW_HOURS`, one conditional UPDATE + `order.receipt_confirmed` audit event per row. Batched by id keyset since issue #348 with the same env knobs; leftovers go to the next tick. |
| Auth-artifact prune (issue #276) | `auth-token-prune.ts` | Every `AUTH_TOKEN_PRUNE_INTERVAL_SECONDS` (default 3600), and once at startup: deletes expired/consumed `EmailVerificationToken`, `PasswordResetToken`, `AdminInvite` and `Sep10Challenge` rows plus revoked `RefreshSession` rows, once they are past `AUTH_TOKEN_PRUNE_GRACE_HOURS`. Each table is drained in `AUTH_TOKEN_PRUNE_BATCH_SIZE`-row statements, up to `AUTH_TOKEN_PRUNE_MAX_BATCHES_PER_RUN` per tick. Active sessions and live tokens are never touched; logs counts only. |
| Referral expiry (issue #8) | `referral-expiry.ts` | Every `REFERRAL_EXPIRY_SWEEP_INTERVAL_SECONDS` (default 3600), and once at startup: moves `pending` referrals untouched for `REFERRAL_PENDING_TTL_DAYS` (default 14) to `expired` with `expiredReason = 'ttl'`. `accepted` referrals are never swept. One conditional UPDATE, so multiple processes are safe. |

Job logs carry error *types* only, never messages — a driver error can echo
the patient data it was handling.

Outbox handlers must be idempotent: a process can crash after a side effect
but before marking an event processed. Admins can inspect dead-letter metadata
at `GET /admin/outbox/dead-letters`; event payloads are not exposed.
