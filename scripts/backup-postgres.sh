#!/usr/bin/env bash
set -euo pipefail

# Phase 9 -- automated Postgres backups.
#
# Takes an encrypted logical backup of the database and writes it to
# ${BACKUP_DIR} with a timestamped filename. Encryption is mandatory
# (backups contain PHI): the dump is piped through `gpg --symmetric` with
# a passphrase supplied via BCKUP_ENCRYPTION_KEY. The plaintext dump
# never touches disk.
#
# Required env:
#   DATABASE_URL                -- Postgres connection string to back up
#   BACKUP_ENCRYPTION_KEY       -- symmetric passphrase for gpg
#   BACKUP_DIR                  -- destination directory (default: ./backups)
#   BACKUP_RETENTION_DAYS        -- retention window in days (default: 14)
#   PG_DUMP_FORMAT              -- "custom" (default) or "plain"

DB_URL="${DATABASE_URL:-}"
KEY="${BACKUP_ENCRYPTION_KEY:-}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
FORMAT="${PG_DUMP_FORMAT:-custom}"

if [ -z "$DB_URL" ]; then
  echo "error: DATABASE_URL is not set" >&2
  exit 2
fi

if [ -z "$KEY" ]; then
  echo "error: BACKUP_ENCRYPTION_KEY is not set (encryption is mandatory)" >&2
  exit 2
fi

if [ "$FORMAT" != "custom" ] && [ "$FORMAT" != "plain" ]; then
  echo "error: PG_DUMP_FORMAT must be custom or plain" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Ym%d_H%M%S)"
outfile="$BACKUP_DIR/postgres-${stamp}.dump.gpg"
tmpfile="${outfile}.part"

echo "[$(stamp)] backing up $DATABASE_URL -> $outfile"

cleanup() {
  rm -f "${tmpfile}" 2>/dev/null || true
}
trap cleanup EXIT

# Pipe the dump straight into gpg so the plaintext dump never exists
# on disk. --batch --yes makes the command non-interactive.
if [ "$FORMAT" = "custom" ]; then
  pg_dump \
    --db="$DB_URL" \
    --format=custom \
    --no-owner \
    --no-privileges \
    --blobs \
    | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase-fd 3>"$tmpfile" 3<< <"$KEY"
        > "$tmpfile" 3<< <"$KEY"
else
  pg_dump "$DB_URL" --no-owner --no-privileges --blobs \
    | gpg --batch --yes -symmetric --cipher-algo AES256 \
        --passphrase-fd 3>"$tmpfile" 3<< <"$KEY"
        > "${tmpfile}" 3<< <"$KEY"
fi

mv "$tmpfile" "$outfile"

size=$(wc -c < "$outfile" | tr -d ' ')
echo "[$(stamp)] wrote $outfile (${size} bytes)"

# Retention: delete backups older than RETENTION_DAYS.
echo "[$(stamp)] applying retention (${RETENTION_DAYS} days)"
find "$BACKUP_DIR" -type f -name 'postgres-*.dump.gpg' -mtime +"$RETENTION_DAYS" -print -delete

echo "[$(stamp)] backup complete"
