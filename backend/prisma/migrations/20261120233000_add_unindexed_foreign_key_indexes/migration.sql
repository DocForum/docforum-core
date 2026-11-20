-- CreateIndex
CREATE INDEX "Appointment_patientProfileId_createdAt_idx" ON "Appointment"("patientProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "Appointment_doctorProfileId_status_idx" ON "Appointment"("doctorProfileId", "status");

-- CreateIndex
CREATE INDEX "Prescription_prescribingDoctorId_idx" ON "Prescription"("prescribingDoctorId");

-- CreateIndex
CREATE INDEX "Prescription_facilityProfileId_idx" ON "Prescription"("facilityProfileId");

-- CreateIndex
CREATE INDEX "LabOrder_facilityProfileId_idx" ON "LabOrder"("facilityProfileId");

-- CreateIndex
CREATE INDEX "LabResult_fulfillingFacilityId_idx" ON "LabResult"("fulfillingFacilityId");
