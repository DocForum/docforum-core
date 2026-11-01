-- Phase 5 (issues #73 + #74): item-level fulfillment and facility location.
--
-- Deliberately adds ONLY what no other migration creates. When this branch
-- was merged with main, two later migrations turned out to own the columns
-- this one originally also added, and `migrate deploy` failed on the second
-- definition (P3018 / 42701: column already exists):
--
--   * `PrescriptionItem.prescriptionId` (+ its index and FK) is added by
--     `20261020000000_order_payment_intents`.
--   * `FulfillmentRecord.facilityId` (+ its index and FK) and the drop of
--     the polymorphic `orderType`/`orderId` pair belong to
--     `20261022090000_fulfillment_record_typed_order_fks` (ADR 0012), which
--     runs after this one and expects to add them itself.
--
-- So the schema-side work those two own stays with them; this file keeps the
-- enum values, the `FulfillmentItem` table and the facility location columns
-- that only Phase 5 introduces.

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

-- AddForeignKey
ALTER TABLE "FulfillmentItem" ADD CONSTRAINT "FulfillmentItem_fulfillmentRecordId_fkey" FOREIGN KEY ("fulfillmentRecordId") REFERENCES "FulfillmentRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
