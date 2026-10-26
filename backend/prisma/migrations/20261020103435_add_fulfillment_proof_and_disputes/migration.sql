-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('pharmacy', 'lab');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('pending', 'resolved');

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "orderType" "OrderType" NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "facilityProfileId" TEXT,
    "prescribingDoctorId" TEXT,
    "details" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'issued',
    "fulfilledAt" TIMESTAMP(3),
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "confirmationSource" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "disputed" BOOLEAN NOT NULL DEFAULT false,
    "disputedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfillmentProof" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "facilityProfileId" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "attachmentUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FulfillmentProof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderDispute" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderDisputeResolution" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "resolutionNotes" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDisputeResolution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_patientProfileId_status_idx" ON "Order"("patientProfileId", "status");

-- CreateIndex
CREATE INDEX "Order_facilityProfileId_status_idx" ON "Order"("facilityProfileId", "status");

-- CreateIndex
CREATE INDEX "Order_status_confirmed_disputed_idx" ON "Order"("status", "confirmed", "disputed");

-- CreateIndex
CREATE INDEX "FulfillmentProof_orderId_idx" ON "FulfillmentProof"("orderId");

-- CreateIndex
CREATE INDEX "FulfillmentProof_facilityProfileId_idx" ON "FulfillmentProof"("facilityProfileId");

-- CreateIndex
CREATE INDEX "OrderDispute_orderId_idx" ON "OrderDispute"("orderId");

-- CreateIndex
CREATE INDEX "OrderDispute_patientProfileId_idx" ON "OrderDispute"("patientProfileId");

-- CreateIndex
CREATE INDEX "OrderDispute_status_idx" ON "OrderDispute"("status");

-- CreateIndex
CREATE INDEX "OrderDisputeResolution_disputeId_idx" ON "OrderDisputeResolution"("disputeId");

-- CreateIndex
CREATE INDEX "OrderDisputeResolution_adminUserId_idx" ON "OrderDisputeResolution"("adminUserId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_facilityProfileId_fkey" FOREIGN KEY ("facilityProfileId") REFERENCES "FacilityProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentProof" ADD CONSTRAINT "FulfillmentProof_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentProof" ADD CONSTRAINT "FulfillmentProof_facilityProfileId_fkey" FOREIGN KEY ("facilityProfileId") REFERENCES "FacilityProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDispute" ADD CONSTRAINT "OrderDispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDispute" ADD CONSTRAINT "OrderDispute_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDisputeResolution" ADD CONSTRAINT "OrderDisputeResolution_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "OrderDispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDisputeResolution" ADD CONSTRAINT "OrderDisputeResolution_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
