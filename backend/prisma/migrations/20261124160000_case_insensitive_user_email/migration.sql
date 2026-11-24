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

-- Enforce case-insensitive email uniqueness at the database level (Issue #268)
CREATE UNIQUE INDEX IF NOT EXISTS "User_lower_email_idx" ON "User" (LOWER("email"));
