-- Add per-specialty verification fields to DoctorSpecialty
ALTER TABLE "DoctorSpecialty" ADD COLUMN "verificationStatus" VARCHAR(191);
ALTER TABLE "DoctorSpecialty" ADD COLUMN "reviewer" VARCHAR(191);
ALTER TABLE "DoctorSpecialty" ADD COLUMN "reviewDate" TIMESTAMP(3);
ALTER TABLE "DoctorSpecialty" ADD COLUMN "rejectionReason" VARCHAR(191);

-- Backfill existing rows: doctors who have doctorProfile assignments get 'pending' status
UPDATE "DoctorSpecialty" SET "verificationStatus" = 'pending' WHERE "verificationStatus" IS NULL;

-- Add index for querying verified doctors by specialty
CREATE INDEX "DoctorSpecialty_verificationStatus_idx" ON "DoctorSpecialty"("verificationStatus");