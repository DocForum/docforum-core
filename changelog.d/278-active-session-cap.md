Phase 8: cap active refresh sessions per user (issue #278).
`MAX_ACTIVE_SESSIONS_PER_USER` (default 10) is enforced inside the session
creation transaction: a per-user `pg_advisory_xact_lock` serialises logins,
then the least recently used sessions beyond the cap are revoked with
`revokedReason = 'max_active_sessions'`. The newly issued session is never
evicted, concurrent logins cannot leave the account above the cap, and an
evicted refresh token gets a 401 at refresh. Migration adds
`RefreshSession.revokedReason`.
