-- Referral expiry job (issue #8). Records when and why a referral expired so
-- a time-based expiry ("ttl") is distinguishable from the no-show cascade
-- ("no_show") and from `declined`/`cancelled`.

-- CreateEnum
CREATE TYPE "ReferralExpiryReason" AS ENUM ('ttl', 'no_show');

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "expiredReason" "ReferralExpiryReason";

-- CreateIndex
CREATE INDEX "Referral_status_updatedAt_idx" ON "Referral"("status", "updatedAt");

-- Backfill: until now the only path to `expired` was the no-show cascade.
UPDATE "Referral" SET "expiredAt" = "updatedAt", "expiredReason" = 'no_show' WHERE "status" = 'expired';
