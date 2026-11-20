-- DropIndex
DROP INDEX "AvailabilitySlot_doctorProfileId_status_idx";

-- CreateIndex
CREATE INDEX "Appointment_doctorProfileId_status_idx" ON "Appointment"("doctorProfileId", "status");

-- CreateIndex
CREATE INDEX "AvailabilitySlot_doctorProfileId_status_startTime_idx" ON "AvailabilitySlot"("doctorProfileId", "status", "startTime");

