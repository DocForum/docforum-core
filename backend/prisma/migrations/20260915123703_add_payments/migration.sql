-- DropIndex
DROP INDEX "WalletLink_stellarPublicKey_key";

-- AlterTable
ALTER TABLE "PaymentIntent" DROP COLUMN "amount",
DROP COLUMN "currency",
ADD COLUMN     "amountStroops" BIGINT NOT NULL,
ADD COLUMN     "escrowId" BIGINT,
ADD COLUMN     "facilityId" TEXT NOT NULL,
ADD COLUMN     "patientProfileId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "WalletLink" DROP COLUMN "verified",
ADD COLUMN     "facilityId" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "PaymentIntent_facilityId_idx" ON "PaymentIntent"("facilityId");

-- CreateIndex
CREATE INDEX "PaymentIntent_status_idx" ON "PaymentIntent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WalletLink_facilityId_key" ON "WalletLink"("facilityId");

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "FacilityProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLink" ADD CONSTRAINT "WalletLink_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "FacilityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

