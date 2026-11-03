-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('pending', 'on_hold', 'accepted', 'expired');

-- AlterEnum
ALTER TYPE "AppointmentStatus" ADD VALUE 'late_cancelled';

-- DropForeignKey
ALTER TABLE "LabOrder" DROP CONSTRAINT "LabOrder_supersedesLabOrderId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentIntent" DROP CONSTRAINT "PaymentIntent_labOrderId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentIntent" DROP CONSTRAINT "PaymentIntent_prescriptionId_fkey";

-- DropForeignKey
ALTER TABLE "Prescription" DROP CONSTRAINT "Prescription_supersedesPrescriptionId_fkey";

-- AlterTable
-- Existing profiles predate timezone capture; preserve them as UTC until
-- their owners can provide a local timezone.
ALTER TABLE "DoctorProfile" ADD COLUMN     "timeZone" TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE "DoctorProfile" ALTER COLUMN "timeZone" DROP DEFAULT;

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "doctorProfileId" TEXT,
    "specialtyId" TEXT,
    "status" TEXT NOT NULL,
    "earliestAcceptable" TIMESTAMP(3) NOT NULL,
    "latestAcceptable" TIMESTAMP(3) NOT NULL,
    "holdDurationMinutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "facilityCapabilityId" TEXT,
    "availabilitySlotId" TEXT,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WindowTime" (
    "id" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WindowTime_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaitlistEntry_status_idx" ON "WaitlistEntry"("status");

-- CreateIndex
CREATE INDEX "WaitlistEntry_patientProfileId_status_idx" ON "WaitlistEntry"("patientProfileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_patientProfileId_doctorProfileId_specialtyId_key" ON "WaitlistEntry"("patientProfileId", "doctorProfileId", "specialtyId");

-- CreateIndex
CREATE UNIQUE INDEX "WindowTime_start_end_key" ON "WindowTime"("start", "end");

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_supersedesPrescriptionId_fkey" FOREIGN KEY ("supersedesPrescriptionId") REFERENCES "Prescription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_supersedesLabOrderId_fkey" FOREIGN KEY ("supersedesLabOrderId") REFERENCES "LabOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_doctorProfileId_fkey" FOREIGN KEY ("doctorProfileId") REFERENCES "DoctorProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_facilityCapabilityId_fkey" FOREIGN KEY ("facilityCapabilityId") REFERENCES "FacilityCapability"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_availabilitySlotId_fkey" FOREIGN KEY ("availabilitySlotId") REFERENCES "AvailabilitySlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_labOrderId_fkey" FOREIGN KEY ("labOrderId") REFERENCES "LabOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
