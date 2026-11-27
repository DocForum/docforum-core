-- CreateEnum
CREATE TYPE "ReferralDeclineReason" AS ENUM ('cost', 'distance', 'second_opinion', 'other');

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN     "declineReason" "ReferralDeclineReason",
ADD COLUMN     "declineReasonNote" VARCHAR(200);

