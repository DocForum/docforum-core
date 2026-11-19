-- Bring the database in line with the schema where earlier migrations
-- diverged from it (found by scripts/check-migration-drift.mjs).

-- 20261016110000_add_specialty_verification created these as VARCHAR(191);
-- the schema has always declared the VerificationStatus enum and plain
-- String (TEXT). Existing values are already enum labels ('pending' /
-- 'verified' / 'rejected'), so the cast keeps every row. The index on the
-- column is rebuilt by ALTER ... TYPE.
ALTER TABLE "DoctorSpecialty" ALTER COLUMN "verificationStatus" DROP DEFAULT;
ALTER TABLE "DoctorSpecialty"
  ALTER COLUMN "verificationStatus" TYPE "VerificationStatus"
  USING "verificationStatus"::"VerificationStatus";
ALTER TABLE "DoctorSpecialty" ALTER COLUMN "verificationStatus" SET DEFAULT 'pending';
ALTER TABLE "DoctorSpecialty" ALTER COLUMN "reviewer" TYPE TEXT;
ALTER TABLE "DoctorSpecialty" ALTER COLUMN "rejectionReason" TYPE TEXT;

-- 20261016120000_add_rate_limit_store indexed (key, scope) and gave
-- updatedAt a database default; the schema indexes (key, scope, consumedAt)
-- (the rate-limit window query filters on all three) and sets updatedAt from
-- Prisma (@updatedAt).
DROP INDEX "RateLimitRecord_key_scope_idx";
CREATE INDEX "RateLimitRecord_key_scope_consumedAt_idx" ON "RateLimitRecord"("key", "scope", "consumedAt");
ALTER TABLE "RateLimitRecord" ALTER COLUMN "updatedAt" DROP DEFAULT;
