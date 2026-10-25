Phase 8: DB-backed feature flags for staged rollouts
([issue #132](https://github.com/DocForum/docforum-core/issues/132)). New
`FeatureFlag` table and `modules/flags`: boolean flags with an optional
percentage rollout, targeted by role or user-id allowlist. The percentage is a
sticky `sha256(flagKey:userId)` bucket, so a user gets the same answer on every
request and raising the percentage never switches anyone off. Evaluation never
throws and defaults to off (unknown flag, bad row, database down with nothing
cached); flags are cached in memory for `FEATURE_FLAG_CACHE_TTL_SECONDS`
(default 15).

`GET /admin/feature-flags` lists them, `PATCH /admin/feature-flags/:key`
creates/changes one and records a `feature_flag.created` / `feature_flag.updated`
`AuditEvent` in the same transaction (the percentage and counts only, never the
allowlisted user ids), and `GET /me/flags` returns the caller's evaluated flags
for the frontend. First user: wallet funding (`payments.wallet_funding`, seeded
**off**) now gates `POST /payments/intents/:id/prepare` with `403
FEATURE_DISABLED` — an admin has to enable it, so existing environments stop
offering it until they do. Migration `20261022100000_feature_flags`. "Per
environment" is by construction: each environment has its own database and so
its own flag rows.
