-- AlterEnum
ALTER TYPE "PaymentIntentStatus" ADD VALUE 'funding';

-- AlterTable
ALTER TABLE "PaymentIntent" ADD COLUMN     "fundingStartedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PaymentIntent_status_fundingStartedAt_idx" ON "PaymentIntent"("status", "fundingStartedAt");

