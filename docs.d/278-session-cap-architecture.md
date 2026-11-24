---
file: ARCHITECTURE.md
section: 4.9 Auth hardening state (Phase 8)
---
**Phase 8, issue #278 — active refresh-session cap.**
`RefreshSession` gains a nullable `revokedReason`; the cap eviction writes
`max_active_sessions` so it is distinguishable from a user or admin
revocation. Session creation now takes a per-user
`pg_advisory_xact_lock`, inserts the new row and revokes the
least-recently-used rows beyond `MAX_ACTIVE_SESSIONS_PER_USER` (default 10)
in the same transaction. The just-issued session is excluded from eviction
and always counts toward the cap. The advisory lock is what makes the cap
hold under concurrent logins (two `READ COMMITTED` transactions would each
otherwise count the pre-login rows). Revoked rows are removed by the #276
prune only after the grace period, so an evicted device gets a clean `401`
at refresh in the meantime.
