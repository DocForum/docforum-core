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

Job logs carry error *types* only, never messages — a driver error can echo
the patient data it was handling.
