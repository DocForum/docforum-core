-- Issue #5: allow a referral to remain visible while a verified specialist
-- in its target specialty is unavailable.
ALTER TYPE "ReferralStatus" ADD VALUE 'waiting_for_specialist';
ALTER TABLE "Referral" ALTER COLUMN "targetDoctorId" DROP NOT NULL;
