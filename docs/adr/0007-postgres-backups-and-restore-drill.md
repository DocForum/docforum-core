# ADR 0007: Postgres backups and a tested restore drill

**Status:** Accepted
**Date:** 2026-10-08
**Phase:** 9 -- Deploy & CI
**Related:** ADR 0003 (preview database has no backups), issue #22 (deployment target)

## Context

The preview database has no backups (ADRɀ0003) and has already been

deleted and recreated once (2026-10-07 renewal). Production can't work that

way. Backups that have never been restored are a hope, not a plan. This

ADR records the backup strategy and the restore drill that proves it works.

## Decision

- We take **encrypted logical backups** with `pg_dump``, encrypted at

  rest with `pgp --symmetric` (AES-256). The dump is piped straight

  into `gpg`, so the plaintext dump never touches disk.

- Backups run on a schedule (daily in CI and on the host) with a

  **14-day retention policy** (`BACKUP_RETENTION_DAYS`).

- A **restore drill** runs on a schedule in CI against staging backups. It
  restores the latest backup into a scratch database and runs integrity
  checks: migration count, row counts for `users` and `bookings`, and a
  sample booking join query.

- Failure of the drill alerts in CI (GitHub Actions failure notification).

## RPO / RTO targets

| Metric | Target | Measured |
|-------|--------|----------|
| RPO (max data loss) | 24 hours | daily backups -- worst case 24h |
| RPO (best case) | 0 | daily 03:00 UTC |
| RPO (continuous) | -- | not yet -- platform PITR is a future item |
| RTO (target) | 60 minutes | -- |
| RRO (measured restore time) | -- | ~10s for the drill dataset; scales with database size |

Measured restore time is printed by `scripts/restore-drill.sh` as

`[restore-drill] measured restore time: <s>s`. Update this table when
the measured time on real staging data changes materially.

## Safety guards

- `RESTORE_CONFIRM=1` is required to acknowledge the restore is a drill.
- The target database name must end in `_drill` or `_scratch`.
- The target must not be the source database.
- Encryption is mandatory: the backup script refuses to run without

  `BACKUP_ENCRYPTION_KEY`.

## Consequences

- Restoring is proven regularly, not just assumed.
- Backups contain PHI; the encryption key lives in the CI secrets

  store / host env, not in the repo.
- The drill runs on a schedule in CI and alerts on failure.
