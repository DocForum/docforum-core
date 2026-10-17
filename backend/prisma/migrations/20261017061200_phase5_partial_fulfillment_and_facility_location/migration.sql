/*
  Warnings:

  - Added the required column `facilityId` to the `FulfillmentRecord` table without a default value. This is not possible if the table is not empty.
  - Added the required column `prescriptionId` to the `PrescriptionItem` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "FulfillmentItemStatus" AS ENUM ('pending', 'dispensed', 'unfulfilled');

-- AlterEnum
ALTER TYPE "FulfillmentStatus" ADD VALUE 'partially_fulfilled';

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'partially_fulfilled';

-- AlterTable
ALTER TABLE "FacilityProfile" ADD COLUMN     "address" TEXT,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "FulfillmentRecord" ADD COLUMN     "facilityId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "PrescriptionItem" ADD COLUMN     "prescriptionId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "FulfillmentItem" (
    "id" TEXT NOT NULL,
    "fulfillmentRecordId" TEXT NOT NULL,
    "orderType" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantityOrdered" INTEGER,
    "quantityDispensed" INTEGER NOT NULL DEFAULT 0,
    "status" "FulfillmentItemStatus" NOT NULL DEFAULT 'pending',
    "dispensedKey" TEXT,
    "dispensedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FulfillmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FulfillmentItem_orderType_orderItemId_idx" ON "FulfillmentItem"("orderType", "orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentItem_fulfillmentRecordId_orderType_orderItemId_key" ON "FulfillmentItem"("fulfillmentRecordId", "orderType", "orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentItem_orderType_dispensedKey_key" ON "FulfillmentItem"("orderType", "dispensedKey");

-- CreateIndex
CREATE INDEX "FacilityProfile_latitude_longitude_idx" ON "FacilityProfile"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "FulfillmentRecord_facilityId_idx" ON "FulfillmentRecord"("facilityId");

-- CreateIndex
CREATE INDEX "FulfillmentRecord_orderType_orderId_idx" ON "FulfillmentRecord"("orderType", "orderId");

-- CreateIndex
CREATE INDEX "PrescriptionItem_prescriptionId_idx" ON "PrescriptionItem"("prescriptionId");

-- AddForeignKey
ALTER TABLE "PrescriptionItem" ADD CONSTRAINT "PrescriptionItem_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentRecord" ADD CONSTRAINT "FulfillmentRecord_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "FacilityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentItem" ADD CONSTRAINT "FulfillmentItem_fulfillmentRecordId_fkey" FOREIGN KEY ("fulfillmentRecordId") REFERENCES "FulfillmentRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
