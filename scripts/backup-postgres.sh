#!/usr/bin/env bash
set -euo pipefail

# Phase 9 -- automated Postgres backups.
#
# Takes an encrypted logical backup of the database and writes it to
# ${BACKUP_DIR} with a timestamped filename. Encryption is mandatory
# (backups contain PHI): the dump is piped through `gpg --symmetric` with
# a passphrase supplied via BACKUP_ENCRYPTION_KEY. The plaintext dump
# never touches disk.
#
# Required env:
#   DATABASE_URL                -- Postgres connection string to back up
#   BACKUP_ENCRYPTION_KEY       -- symmetric passphrase for gpg
#   BACKUP_DIR                  -- destination directory (default: ./backups)
#   BACKUP_RETENTION_DAYS       -- retention window in days (default: 14)
#
# The dump is always pg_dump's custom format, which is what
# scripts/restore-drill.sh restores with pg_restore.

DB_URL="${DATABASE_URL:-}"
KEY="${BACKUP_ENCRYPTION_KEY:-}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ -z "$DB_URL" ]; then
  echo "error: DATABASE_URL is not set" >&2
  exit 2
fi

if [ -z "$KEY" ]; then
  echo "error: BACKUP_ENCRYPTION_KEY is not set (encryption is mandatory)" >&2
  exit 2
fi

case "$RETENTION_DAYS" in
  ''|*[!0-9]*) echo "error: BACKUP_RETENTION_DAYS must be a whole number of days" >&2; exit 2 ;;
esac

mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%d_%H%M%S)"
outfile="$BACKUP_DIR/postgres-${stamp}.dump.gpg"
tmpfile="${outfile}.part"

# Never log the connection string itself: it carries the password.
echo "[$(ts)] backing up ${DB_URL%%://*}://… -> $outfile"

cleanup() {
  rm -f "${tmpfile}" 2>/dev/null || true
}
trap cleanup EXIT

# Pipe the dump straight into gpg so the plaintext dump never exists
# on disk. The passphrase goes in on fd 3 so it never appears in argv;
# --pinentry-mode loopback lets gpg 2.x read it non-interactively.
pg_dump \
  --dbname="$DB_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  | gpg --batch --yes --pinentry-mode loopback \
      --symmetric --cipher-algo AES256 \
      --passphrase-fd 3 \
      --output "$tmpfile" 3<<<"$KEY"

mv "$tmpfile" "$outfile"

size=$(wc -c < "$outfile" | tr -d ' ')
echo "[$(ts)] wrote $outfile (${size} bytes)"

# Retention: delete backups older than RETENTION_DAYS.
echo "[$(ts)] applying retention (${RETENTION_DAYS} days)"
find "$BACKUP_DIR" -type f -name 'postgres-*.dump.gpg' -mtime +"$RETENTION_DAYS" -print -delete

echo "[$(ts)] backup complete"
