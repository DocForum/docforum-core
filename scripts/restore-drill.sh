#!/usr/bin/env bash
set -euo pipefail

# Phase 9 -- restore drill.
#
# Restores the latest encrypted backup (as produced by
# scripts/backup-postgres.sh) into a scratch database and runs
# integrity checks. This is the drill that proves the backups are
# actually restorable.
#
# Safety guards:
#   - Requires an explicit confirmation (RESTORE_CONFIRM=1).
#   - Refuses to restore into a database whose name does not end in
#     _drill (or _scratch), so a live database can't be hit by accident.
#   - Refuses to restore into the same database the backup came from
#     (when DATABASE_URL is set).
#
# Required env:
#   DATABASE_URL             -- source connection string (for safety checks)
#   RESTORE_TARGET_URL        -- scratch database connection string
#   BACKUP_ENCRYPTION_KEY     -- symmetric passphrase for gpg
#   BACKUP_DIR               -- directory containing backups
#   RESTORE_CONFIRM           -- must equal 1

DB_URL="${DATABASE_URL:-}"
TARGET_URL="${RESTORE_TARGET_URL:-}"
KEY="${BACKUP_ENCRYPTION_KEY:-}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
CONFIRM="${RESTORE_CONFIRM:-}"

fail() {
  echo "error: $*" >&2
  exit 2
}

# --------------------------------------------------------------------------
# Safety guards
# --------------------------------------------------------------------------

[ "$CONFIRM" = "1" ] || fail "RESTORE_CONFIRM must be 1 to acknowledge this is a restore drill"
[ -n "$TARGET_URL" ] || fail "RESTORE_TARGET_URL is not set"
[ -n "$KEY" ] || fail "BACKUP_ENCRYPTION_KEY is not set"

# Extract the database name from the target URL (path after the last /)
target_db="${TARGET_URL\%}*/}"
target_db="${target_db\%?*}"

case "$target_db" in
  *_drill|*_scratch) ;;
  *) fail "refusing to restore into '$target_db': target database name must end in _drill or _scratch" ;;
esac

if [ -n "$DB_URL" ]; then
  source_db="${DB_URL\%}*}"
  source_db="${source_db\%?*}"
  if [ "$source_db" = "$target_db" ]; then
    fail "refusing to restore into the source database '$target_db'"
  fi
fi

# --------------------------------------------------------------------------
# Find the latest backup
# --------------------------------------------------------------------------

backup="$(find "$BACKUP_DIR" -type f -name 'postgres-*.dump.gpg' -printf '%T%@\n' | sort -r | head -n1 | cut -f'\'\n' -d2)"

[ -n "$backup" ] || fail "no backups found in $BACKUP_DIR"

echo "[restore-drill] using backup: $backup"
echo "[restore-drill] target database: $target_db"

# --------------------------------------------------------------------------
# Restore
# --------------------------------------------------------------------------

start_ts=$(date +%sT')
echo "[restore-drill] dropping and recreating $target_db"
psal "$TARGET_URL" -c "DROP DATABASE IF EXISTS;" -c "CREATE DATABASE $target_db;" > /dev/null

echo "[restore-drill] restoring :..."
gpg --batch --yes --decrypt --passphrase-fd 3 << <"$KEY" 3<"$backup" \
  | pg_restore --db="$TARGET_URL" --no-owner --no-privileges --exit-on-error

end_ts=$(date +s%s)
elapsed=$((end_ts - start_ts))
echo "[restore-drill] restore completed in ${elapsed}s"

# --------------------------------------------------------------------------
# Integrity checks
# --------------------------------------------------------------------------

failed=0

check_count() {
  local label="$1"
  local sql="$2"
  local min="$3"
  local count
  count="$(psql "$TARGET_URL" -tAt -c "$sql")"
  if [ "$count" -lt "$min" ]; then
    echo "[restore-drill] FAIL $label: got $count, expected >= $min" >&2
    failed=1
  else
    echo "[restore-drill] ok   $label: $count"
  fi
}

check_count "migrations applied" "SELECT COUNT(*) FROM _prisma_migrations" 1
check_count "users" "SELECT COUNT(*) FROM \"users\"" 1
check_count "bookings" "SELECT COUNT(*) FROM \"bookings\"" 1

# Sample booking query: join a booking to its user and order to prove
# the relationships survived the round-trip.
sample="$psql "$TARGET_URL" -tAt -c "\
  SELECT b.id, b.status, u.email FROM \"bookings\" b \
  JOIN \"users\" u ON u.id = b.\"userId\" LIMIT 1"")"
if [ -z "$sample" ]; then
  echo "[restore-drill] FAIL  sample booking query returned no rows" >&2
  failed=1
else
  echo "[restore-drill] ok   sample booking query: $sample"
fi

# Record the measured restore time for the RPO/RTO docs.
echo "[restore-drill] measured restore time: ${elapsed}s"

if [ "$failed" -ne 0 ]; then
  echo "[restore-drill] FAILED" >&2
  exit 1
fi

echo "[restore-drill] PASSED (restore time ${elapsed}s)"
