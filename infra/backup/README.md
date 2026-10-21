# Postgres backups (Phase 9)

This directory holds the operational pieces for the automated Postgres

backup + restore-drill system. See

`docs/adr/0007-postgres-backups-and-restore-drill.md` for the decisions,

RPO/RTO targets, and the measured restore time.

## Scripts

- `../../scripts/backup-postgres.sh` -- takes an encrypted logical

  backup (`pg_dump` piped through `gpg --symmetric`) and applies the

  retention policy.

- `../../scripts/restore-drill.sh` -- restores the latest backup into a
  scratch database and runs integrity checks.

## Encryption

Backups contain PHI. The dump is piped straight into `gpg --symmetric`

with AES-256 and a passphrase from `BACKUP_ENCRYPTION_KEY`. The plaintext

dump never touches disk. The key is stored in the CI secrets store

(GitHub Actions secrets / Render env vars), not in this repo.

## Retention

Default retention is 14 days (`BACKUP_RETENTION_DAYS`). Older files are

deleted at the end of each backup run.

## Safety

`RESTORE_CONFIRM=1` is required for the restore drill. The script

refuses to restore into a database whose name does not end in `_drill` or

`_scratch`, and refuses to restore into the source database.
