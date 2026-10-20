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
#   RESTORE_TARGET_URL       -- scratch database connection string
#   BACKUP_ENCRYPTION_KEY    -- symmetric passphrase for gpg
#   BACKUP_DIR               -- directory containing backups
#   RESTORE_CONFIRM          -- must equal 1
#
# The scratch database is dropped and recreated through the server's
# `postgres` maintenance database, so the role in RESTORE_TARGET_URL needs
# CREATEDB.

DB_URL="${DATABASE_URL:-}"
TARGET_URL="${RESTORE_TARGET_URL:-}"
KEY="${BACKUP_ENCRYPTION_KEY:-}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
CONFIRM="${RESTORE_CONFIRM:-}"

fail() {
  echo "error: $*" >&2
  exit 2
}

# Database name from a connection string: the path after the last /,
# without any ?query.
db_name() {
  local name="${1##*/}"
  echo "${name%%\?*}"
}

# --------------------------------------------------------------------------
# Safety guards
# --------------------------------------------------------------------------

[ "$CONFIRM" = "1" ] || fail "RESTORE_CONFIRM must be 1 to acknowledge this is a restore drill"
[ -n "$TARGET_URL" ] || fail "RESTORE_TARGET_URL is not set"
[ -n "$KEY" ] || fail "BACKUP_ENCRYPTION_KEY is not set"

target_db="$(db_name "$TARGET_URL")"

# The name is interpolated into DROP/CREATE DATABASE below, so only allow
# plain identifiers.
[[ "$target_db" =~ ^[A-Za-z0-9_]+$ ]] || fail "target database name '$target_db' must be letters, digits and underscores only"

case "$target_db" in
  *_drill|*_scratch) ;;
  *) fail "refusing to restore into '$target_db': target database name must end in _drill or _scratch" ;;
esac

if [ -n "$DB_URL" ]; then
  source_db="$(db_name "$DB_URL")"
  if [ "$source_db" = "$target_db" ]; then
    fail "refusing to restore into the source database '$target_db'"
  fi
fi

# --------------------------------------------------------------------------
# Find the latest backup
# --------------------------------------------------------------------------

backup="$(find "$BACKUP_DIR" -type f -name 'postgres-*.dump.gpg' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2-)"

[ -n "$backup" ] || fail "no backups found in $BACKUP_DIR"

echo "[restore-drill] using backup: $backup"
echo "[restore-drill] target database: $target_db"

# --------------------------------------------------------------------------
# Restore
# --------------------------------------------------------------------------

admin_url="${TARGET_URL%/*}/postgres"
start_ts=$(date +%s)
echo "[restore-drill] dropping and recreating $target_db"
psql "$admin_url" -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS \"$target_db\";" \
  -c "CREATE DATABASE \"$target_db\";"

echo "[restore-drill] restoring ..."
gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 --decrypt "$backup" 3<<<"$KEY" \
  | pg_restore --dbname="$TARGET_URL" --no-owner --no-privileges --exit-on-error

end_ts=$(date +%s)
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
  count="$(psql "$TARGET_URL" -tAX -c "$sql")"
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

# Sample booking query: join a booking to its user to prove the
# relationships survived the round-trip.
sample="$(psql "$TARGET_URL" -tAX -c "
  SELECT b.id, b.status, u.email FROM \"bookings\" b
  JOIN \"users\" u ON u.id = b.\"userId\" LIMIT 1")"
if [ -z "$sample" ]; then
  echo "[restore-drill] FAIL sample booking query returned no rows" >&2
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
