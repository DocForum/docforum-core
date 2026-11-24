-- Map any unexpected status values to 'expired' before casting
UPDATE "WaitlistEntry"
SET "status" = CASE
  WHEN "status" IN ('pending', 'on_hold', 'accepted', 'expired') THEN "status"
  ELSE 'expired'
END;

-- Convert status column from TEXT to WaitlistStatus enum
ALTER TABLE "WaitlistEntry"
  ALTER COLUMN "status" TYPE "WaitlistStatus" USING "status"::"WaitlistStatus";
ALTER TABLE "WaitlistEntry"
  ALTER COLUMN "status" SET DEFAULT 'pending';

-- Drop the old unique index that blocked re-entry after acceptance/expiry and did not handle null specialties
DROP INDEX IF EXISTS "WaitlistEntry_patientProfileId_doctorProfileId_specialtyId_key";

-- Create partial unique index covering active entries (with NULL-safe handling via NULLS NOT DISTINCT)
CREATE UNIQUE INDEX "WaitlistEntry_active_unique" ON "WaitlistEntry" (
  "patientProfileId",
  "doctorProfileId",
  "specialtyId"
) NULLS NOT DISTINCT
WHERE "status" IN ('pending', 'on_hold');
