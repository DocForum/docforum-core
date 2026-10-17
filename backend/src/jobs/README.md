# jobs

Background jobs (reminders, order-expiry checks, notification delivery).

Per ARCHITECTURE_ESSENTIALS.md: keep this simple (cron/interval) until a
real job exists — do not introduce a queue (e.g. BullMQ/Redis) preemptively.
See ARCHITECTURE.md §6.3.2 for the overengineering flag on this exact point.

Jobs are started from `src/server.ts` only, never from `app.ts`, so test
suites that build the app don't start timers.

| Job | File | What it does |
|---|---|---|
| Login-throttle prune (issue #35) | `src/server.ts` | Deletes stale `LoginAttempt` buckets. |
| Deleted-account purge (issue #41, ADR 0007) | `account-purge.ts` | Every `ACCOUNT_PURGE_INTERVAL_SECONDS`: hard-deletes anonymised patients that no module holds records for (`src/retention-holds.ts`), once `ACCOUNT_PURGE_GRACE_HOURS` has passed. Never deletes clinical, order or payment rows. Logs counts and error types only. |
