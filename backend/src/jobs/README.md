# jobs

Background jobs (reminders, order-expiry checks, notification delivery).

Per ARCHITECTURE_ESSENTIALS.md: keep this simple (cron/interval) until a
real job exists — do not introduce a queue (e.g. BullMQ/Redis) preemptively.
See ARCHITECTURE.md §6.3.2 for the overengineering flag on this exact point.

Jobs are started from `src/server.ts` only, never from `app.ts`, so test
suites that build the app don't start timers. Each job is a thin scheduler
around a module's service function; the state transitions themselves are
conditional UPDATEs in that module, so running more than one process is
safe. "Once at startup" below means the scheduler also runs its sweep
immediately when the process boots, not just on the interval.

## Jobs in `src/jobs/`

| Job | File | Schedule and env var | What it changes | Safe with multiple processes? |
|---|---|---|---|---|
| Patient-export worker (issue #40) | `patient-exports.ts` | Every `PATIENT_EXPORT_WORKER_INTERVAL_SECONDS` (default 15), and woken immediately when a new export is requested. | Claims and generates pending `PatientExport` jobs one at a time; requeues claims older than `PATIENT_EXPORT_STALE_AFTER_SECONDS` (up to `PATIENT_EXPORT_MAX_ATTEMPTS`). | Yes — claiming is a conditional UPDATE, so two workers racing for one export produce exactly one generation. |
| Patient-export cleanup (issue #40) | `patient-exports.ts` | Every `PATIENT_EXPORT_CLEANUP_INTERVAL_SECONDS` (default 300). | Expires `ready` exports past `expiresAt` and deletes their chunks, plus any chunk that can never be served. | Yes — deletes are keyed on state that another run also only deletes. |
| Escrow event poller (issue #86) | `escrow-events.ts` | Every `ESCROW_EVENT_POLL_INTERVAL_SECONDS` (default 15) and once at startup. Disabled entirely (`ESCROW_CONTRACTS`, or the legacy `ESCROW_CONTRACT_ID` + `ESCROW_EVENT_START_LEDGER`, unset) when no contract is configured. | Advances each contract's `EscrowEventCursor`, upserts `EscrowChainEvent` rows from Soroban RPC, and reconciles `pending` events to `matched` / `unmatched` (alerting on unmatched releases/refunds). | Mostly — event rows are deduplicated by the `(contractId, eventId)` unique key via `upsert` and reconciliation uses conditional UPDATEs, so no duplicate rows or alerts. The cursor is a last-write-wins overwrite, so two pollers can re-read the same window without corrupting state. |
| Transactional outbox dispatcher (issue #94) | `outbox-events.ts` | Every 5 seconds, hard-coded in the job (`WORKER_INTERVAL_MS`); no env var and no startup run. | Claims due `OutboxEvent` rows with `FOR UPDATE SKIP LOCKED`, calls handlers at least once, retries with bounded exponential backoff, and dead-letters after 5 attempts. Also the durable queue for automatic payment settlement (issues #83/#84): `order.fulfilled` releases, `order.rejected`/`order.expired` refund. | Yes — row leases; handlers must be idempotent because a process can crash after a side effect but before marking the event processed. |
| Lab-result escalation (issue #72) | `lab-result-escalation.ts` | Every `LAB_RESULT_ESCALATION_SWEEP_SECONDS` (default 300) and once at startup. | Marks overdue unacknowledged abnormal/critical `LabResultAcknowledgement` rows as escalated with one conditional UPDATE. A missed tick is still visible because the admin queue derives `overdue` from the deadline. | Yes — the acknowledgement that wins the race is never escalated afterwards. |
| Deleted-account purge (issue #41, ADR 0010) | `account-purge.ts` | Every `ACCOUNT_PURGE_INTERVAL_SECONDS` (default 21600 = 6 h); no startup run. | Hard-deletes anonymised patients that no module holds records for (`src/retention-holds.ts`), once `ACCOUNT_PURGE_GRACE_HOURS` (default 24) has passed. Never deletes clinical, order or payment rows. | Yes — each delete is a conditional `deleteAnonymizedProfile` inside a transaction, and `RESTRICT` FKs still refuse a row something else references. Logs counts and error types only. |
| Prepared-payment expiry (issue #80) | `payment-intents.ts` | Every `PAYMENT_PREPARE_EXPIRY_SWEEP_INTERVAL_SECONDS` (default 60) and once at startup. | Moves `PaymentIntent`s stuck in `awaiting_signature` past their prepared window (`PAYMENT_PREPARE_TTL_SECONDS`, default 300) back to `created`, clearing the prepared transaction. Expiry is a normal case — the patient prepares again. | Yes — conditional UPDATE on status and deadline. |
| Referral expiry (issue #8) | `referral-expiry.ts` | Every `REFERRAL_EXPIRY_SWEEP_INTERVAL_SECONDS` (default 3600) and once at startup; `REFERRAL_PENDING_TTL_DAYS` (default 14) sets the age. | Moves `pending` referrals untouched for the TTL to `expired` with `expiredReason = 'ttl'`. `accepted` referrals are never swept. | Yes — one conditional UPDATE. |
| Unconfirmed-order expiry (issue #76) | `order-expiry.ts` | Every `ORDER_EXPIRY_INTERVAL_SECONDS` (default 300) and once at startup; `ORDER_CONFIRMATION_WINDOW_HOURS` (default 72) sets the window. Batched by `EXPIRY_SWEEP_BATCH_SIZE` (default 100) up to `EXPIRY_SWEEP_MAX_PER_RUN` (default 1000) per run; leftovers go to the next tick. | Auto-confirms fulfilled, unconfirmed, undisputed orders past the window, one conditional UPDATE plus an `order.receipt_confirmed` audit event per row, in the same transaction. | Yes — the loser of a race updates 0 rows and writes no second audit event. |
| Lab-order expiry (issues #12/#84) | `lab-order-expiry.ts` (the timer is created inline in `server.ts`) | Every hour, hard-coded in `server.ts` (`60 * 60 * 1000`); no env var and no startup run. Uses the same `EXPIRY_SWEEP_BATCH_SIZE` / `EXPIRY_SWEEP_MAX_PER_RUN` bounds. | Moves `issued` lab orders past `expiresAt` to `expired` with a conditional UPDATE and publishes `order.expired` in the same transaction, which the outbox worker turns into an automatic escrow refund. | Yes — the `status: 'issued'` predicate is the guard, so a concurrent fulfilment cannot be expired and no refund is published twice. |
| Follow-up expiry (issue #63) | `follow-up-expiry.ts` | Every `CONSULTATION_FOLLOW_UP_SWEEP_INTERVAL_SECONDS` (default 3600) and once at startup. | Moves open follow-up requests past the window offered at creation (`CONSULTATION_FOLLOW_UP_WINDOW_DAYS`, default 14) to `expired`. | Yes — one conditional UPDATE. |
| Consultation sign-off (issue #64) | `consultation-sign-off.ts` | Every `CONSULTATION_SIGN_OFF_SWEEP_INTERVAL_SECONDS` (default 3600) and once at startup; `CONSULTATION_AUTO_SIGN_OFF_HOURS` (default 24) sets the grace period. | Signs consultation notes nobody signed manually after the grace period. | Yes — `WHERE signedAt IS NULL AND createdAt < cutoff` cannot re-sign or alter a signed note. |
| Auth-artifact prune (issue #276) | `auth-token-prune.ts` | Every `AUTH_TOKEN_PRUNE_INTERVAL_SECONDS` (default 3600) and once at startup; `AUTH_TOKEN_PRUNE_GRACE_HOURS` (default 24). | Deletes expired/consumed `EmailVerificationToken`, `PasswordResetToken`, `AdminInvite` and `Sep10Challenge` rows plus revoked `RefreshSession` rows. Each table is drained in `AUTH_TOKEN_PRUNE_BATCH_SIZE`-row statements (default 500), up to `AUTH_TOKEN_PRUNE_MAX_BATCHES_PER_RUN` per tick (default 20). | Yes — deletes are scoped to already-expired/consumed/revoked rows past the grace period. Active sessions and live tokens are never touched; logs counts only. |

## Jobs and timers defined inline in `src/server.ts`

These have no `src/jobs/` scheduler file. They live in `server.ts` because
each is a thin wrapper over a module service (or, for the two prunes below,
a single cheap statement). Lab-order expiry is the exception: its sweep lives
in `src/jobs/lab-order-expiry.ts`, but `server.ts` creates its timer inline, so
its row is in the table above rather than here.

| Job | Where | Schedule and env var | What it changes | Safe with multiple processes? |
|---|---|---|---|---|
| Login-throttle prune (issue #35) | `src/server.ts` (`pruneLoginAttempts`) | One shared interval every `LOGIN_THROTTLE_PRUNE_INTERVAL_SECONDS` (default 3600); rows older than `LOGIN_THROTTLE_PRUNE_AFTER_SECONDS` (default 86400) are removed. | Deletes stale `LoginAttempt` buckets. | Yes — a plain age-scoped DELETE; a row another process already removed simply does not match. |
| Access-log prune (issue #45) | `src/server.ts` (`pruneOldAccessLogs`) | Same shared interval as the login-throttle prune; age comes from `ACCESS_LOG_RETENTION_DAYS` (default 365). | Deletes `AccessLog` PHI-access rows past the retention window. | Yes — age-scoped DELETE. |
| Idempotency-key prune (issue #48) | `src/server.ts` (`pruneIdempotencyKeys`) | Same shared interval; TTL is `IDEMPOTENCY_RECORD_TTL_HOURS` (default 24). | Deletes expired `IdempotencyRecord` rows. Correctness does not depend on it, but it keeps the table bounded. | Yes — age-scoped DELETE. |
| Notification fan-out LISTEN (issue #330) | Started by `startNotificationFanout` from `src/server.ts`; implemented in `modules/notifications/services/fanout.ts` | No interval: one long-lived Postgres `LISTEN` connection per process, reconnecting with backoff (`NOTIFICATION_FANOUT_RECONNECT_MIN_MS` default 500, `..._MAX_MS` default 30000). With `NOTIFICATION_FANOUT_DRIVER=local` the broker is in-process and opens no connection. | Writes nothing. Relays `pg_notify` payloads published by whichever instance handled the request to this instance's local SSE streams, and broadcasts a `resync` event after a reconnect. | Yes — every instance has its own listener, and the `NOTIFY` is sent in the writer's transaction after its DB change commits. |

## Notes

- The three `server.ts` prunes above share a single `setInterval`. Hourly is
  far more often than a 365-day access-log window needs, but a second timer
  for one cheap DELETE each was not worth the complexity.
- As written today, `src/server.ts` invokes several `start*` functions twice
  (once at module load, once again before the lab-order timer), so those
  jobs get two timers per process. Every transition they make is conditional,
  so this is redundant work rather than incorrect behaviour; it is recorded
  here as it is, not as a proposed fix.
- Job logs carry error *types* only, never messages — a driver error can echo
  the patient data it was handling.
- Outbox handlers must be idempotent: a process can crash after a side effect
  but before marking an event processed. Admins can inspect dead-letter metadata
  at `GET /admin/outbox/dead-letters`; event payloads are not exposed.
