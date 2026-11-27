-- Preflight check: prevent migration if case duplicates exist
DO $$
BEGIN
  IF EXISTS (
    SELECT LOWER("email")
    FROM "User"
    GROUP BY LOWER("email")
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create unique index on LOWER("email"): duplicate emails with different casing exist. Run backend/scripts/preflight-case-sensitive-emails.mjs to inspect and resolve them.';
  END IF;
END $$;

-- Canonicalise existing rows: the API now lowercases every email it receives
-- (login included), so a row stored as "Ana@x.com" would otherwise become
-- unreachable by login. Safe after the check above: no two rows share a
-- lowercased value. Tombstoned emails of deleted accounts are rewritten too,
-- which keeps them unique and unusable.
UPDATE "User" SET "email" = LOWER("email") WHERE "email" <> LOWER("email");
UPDATE "AdminInvite" SET "email" = LOWER("email") WHERE "email" <> LOWER("email");

-- Enforce case-insensitive email uniqueness at the database level (Issue #268)
CREATE UNIQUE INDEX IF NOT EXISTS "User_lower_email_idx" ON "User" (LOWER("email"));
