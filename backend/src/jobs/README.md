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
| Deleted-account purge (issue #41, ADR 0010) | `account-purge.ts` | Every `ACCOUNT_PURGE_INTERVAL_SECONDS`: hard-deletes anonymised patients that no module holds records for (`src/retention-holds.ts`), once `ACCOUNT_PURGE_GRACE_HOURS` has passed. Never deletes clinical, order or payment rows. Logs counts and error types only. |
| Prepared-payment expiry (issue #80) | `payment-intents.ts` | Every `PAYMENT_PREPARE_EXPIRY_SWEEP_INTERVAL_SECONDS` (default 60): moves `PaymentIntent`s stuck in `awaiting_signature` past their `preparedExpiresAt` back to `created`, clearing the prepared transaction. Expiry is a normal case — the patient prepares again. |
| Referral expiry (issue #8) | `referral-expiry.ts` | Every `REFERRAL_EXPIRY_SWEEP_INTERVAL_SECONDS` (default 3600), and once at startup: moves `pending` referrals untouched for `REFERRAL_PENDING_TTL_DAYS` (default 14) to `expired` with `expiredReason = 'ttl'`. `accepted` referrals are never swept. One conditional UPDATE, so multiple processes are safe. |

Job logs carry error *types* only, never messages — a driver error can echo
the patient data it was handling.
