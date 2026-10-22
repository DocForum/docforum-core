-- Phase 8, issue #42 (docs/adr/0011): replace the unenforced
-- PatientProfile.guardianUserId string with a real Guardianship relation.
--
-- Safety: no code ever wrote guardianUserId, so every row should be NULL.
-- If any isn't, its meaning is unknown (the old field was explicitly
-- "don't build on this"), so stop here and let an operator decide rather
-- than silently dropping or reinterpreting it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PatientProfile" WHERE "guardianUserId" IS NOT NULL) THEN
    RAISE EXCEPTION 'PatientProfile.guardianUserId has non-null values; resolve them before applying guardian_dependent_profiles (see docs/adr/0011).';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "PatientProfile" DROP COLUMN "guardianUserId",
ALTER COLUMN "userId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Guardianship" (
    "id" TEXT NOT NULL,
    "guardianUserId" TEXT NOT NULL,
    "dependentProfileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Guardianship_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Guardianship_dependentProfileId_idx" ON "Guardianship"("dependentProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "Guardianship_guardianUserId_dependentProfileId_key" ON "Guardianship"("guardianUserId", "dependentProfileId");

-- AddForeignKey
ALTER TABLE "Guardianship" ADD CONSTRAINT "Guardianship_guardianUserId_fkey" FOREIGN KEY ("guardianUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guardianship" ADD CONSTRAINT "Guardianship_dependentProfileId_fkey" FOREIGN KEY ("dependentProfileId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A dependent (no login) must carry a date of birth: the age-of-majority
-- rule that ends guardian access is computed from it. Profiles with a login
-- are unaffected (dateOfBirth stays optional for them).
ALTER TABLE "PatientProfile" ADD CONSTRAINT "PatientProfile_dependent_has_dob"
  CHECK ("userId" IS NOT NULL OR "dateOfBirth" IS NOT NULL);
