-- Issue #9: turn the order placeholders into immutable, relational records.
-- Issue #85: replace polymorphic PaymentIntent order references with real FKs.

-- Consultation existed as a placeholder; attach it to exactly one appointment.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Consultation") THEN
    RAISE EXCEPTION 'Issue #9 migration requires placeholder Consultation rows to be reviewed before migration';
  END IF;
END $$;
ALTER TABLE "Consultation" ADD COLUMN "appointmentId" TEXT NOT NULL;
CREATE UNIQUE INDEX "Consultation_appointmentId_key" ON "Consultation"("appointmentId");
ALTER TABLE "Consultation" ADD CONSTRAINT "Consultation_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- These order tables were Phase 0 placeholders. Refuse to reinterpret any
-- pre-existing clinical rows as valid issued records without their missing
-- patient, clinician and consultation provenance.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Prescription") OR EXISTS (SELECT 1 FROM "PrescriptionItem") OR EXISTS (SELECT 1 FROM "LabOrder") OR EXISTS (SELECT 1 FROM "LabResult") THEN
    RAISE EXCEPTION 'Issue #9 migration requires placeholder Prescription/LabOrder rows to be reviewed before migration';
  END IF;
END $$;

ALTER TABLE "Prescription"
  ADD COLUMN "consultationId" TEXT NOT NULL,
  ADD COLUMN "patientProfileId" TEXT NOT NULL,
  ADD COLUMN "prescribingDoctorId" TEXT NOT NULL,
  ADD COLUMN "facilityProfileId" TEXT NOT NULL,
  ADD COLUMN "amountStroops" BIGINT NOT NULL,
  ADD COLUMN "supersedesPrescriptionId" TEXT;
ALTER TABLE "PrescriptionItem" ADD COLUMN "prescriptionId" TEXT NOT NULL;
ALTER TABLE "LabOrder"
  ADD COLUMN "consultationId" TEXT NOT NULL,
  ADD COLUMN "patientProfileId" TEXT NOT NULL,
  ADD COLUMN "orderingDoctorId" TEXT NOT NULL,
  ADD COLUMN "facilityProfileId" TEXT NOT NULL,
  ADD COLUMN "amountStroops" BIGINT NOT NULL,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "supersedesLabOrderId" TEXT;
ALTER TABLE "LabResult"
  ADD COLUMN "labOrderId" TEXT NOT NULL,
  ADD COLUMN "fulfillingFacilityId" TEXT NOT NULL;

CREATE UNIQUE INDEX "Prescription_supersedesPrescriptionId_key" ON "Prescription"("supersedesPrescriptionId");
CREATE INDEX "Prescription_patientProfileId_createdAt_idx" ON "Prescription"("patientProfileId", "createdAt");
CREATE INDEX "Prescription_consultationId_idx" ON "Prescription"("consultationId");
CREATE INDEX "PrescriptionItem_prescriptionId_idx" ON "PrescriptionItem"("prescriptionId");
CREATE UNIQUE INDEX "LabOrder_supersedesLabOrderId_key" ON "LabOrder"("supersedesLabOrderId");
CREATE INDEX "LabOrder_patientProfileId_createdAt_idx" ON "LabOrder"("patientProfileId", "createdAt");
CREATE INDEX "LabOrder_consultationId_idx" ON "LabOrder"("consultationId");
CREATE UNIQUE INDEX "LabResult_labOrderId_key" ON "LabResult"("labOrderId");

ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_prescribingDoctorId_fkey" FOREIGN KEY ("prescribingDoctorId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_facilityProfileId_fkey" FOREIGN KEY ("facilityProfileId") REFERENCES "FacilityProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_supersedesPrescriptionId_fkey" FOREIGN KEY ("supersedesPrescriptionId") REFERENCES "Prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrescriptionItem" ADD CONSTRAINT "PrescriptionItem_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_orderingDoctorId_fkey" FOREIGN KEY ("orderingDoctorId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_facilityProfileId_fkey" FOREIGN KEY ("facilityProfileId") REFERENCES "FacilityProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LabOrder" ADD CONSTRAINT "LabOrder_supersedesLabOrderId_fkey" FOREIGN KEY ("supersedesLabOrderId") REFERENCES "LabOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_labOrderId_fkey" FOREIGN KEY ("labOrderId") REFERENCES "LabOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_fulfillingFacilityId_fkey" FOREIGN KEY ("fulfillingFacilityId") REFERENCES "FacilityProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Remove preview/manual intents without a resolvable order. Never discard a
-- funded or terminal payment record; abort and require an operator review.
DELETE FROM "PaymentIntent"
WHERE "status" = 'created'
  AND (("orderType" = 'prescription' AND NOT EXISTS (SELECT 1 FROM "Prescription" WHERE "Prescription"."id" = "PaymentIntent"."orderId"))
    OR ("orderType" = 'lab_order' AND NOT EXISTS (SELECT 1 FROM "LabOrder" WHERE "LabOrder"."id" = "PaymentIntent"."orderId")));
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "PaymentIntent"
    WHERE ("PaymentIntent"."orderType" = 'prescription' AND NOT EXISTS (SELECT 1 FROM "Prescription" WHERE "Prescription"."id" = "PaymentIntent"."orderId"))
       OR ("PaymentIntent"."orderType" = 'lab_order' AND NOT EXISTS (SELECT 1 FROM "LabOrder" WHERE "LabOrder"."id" = "PaymentIntent"."orderId"))
  ) THEN RAISE EXCEPTION 'Orphaned non-created PaymentIntent rows need manual reconciliation'; END IF;
END $$;

ALTER TABLE "PaymentIntent" ADD COLUMN "prescriptionId" TEXT, ADD COLUMN "labOrderId" TEXT;
UPDATE "PaymentIntent" SET "prescriptionId" = "orderId" WHERE "orderType" = 'prescription';
UPDATE "PaymentIntent" SET "labOrderId" = "orderId" WHERE "orderType" = 'lab_order';
ALTER TABLE "PaymentIntent" DROP COLUMN "orderType", DROP COLUMN "orderId";
DROP TYPE "OrderTypeForPayment";
CREATE UNIQUE INDEX "PaymentIntent_prescriptionId_key" ON "PaymentIntent"("prescriptionId");
CREATE UNIQUE INDEX "PaymentIntent_labOrderId_key" ON "PaymentIntent"("labOrderId");
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_exactly_one_order_check"
  CHECK (("prescriptionId" IS NOT NULL) <> ("labOrderId" IS NOT NULL));
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_labOrderId_fkey" FOREIGN KEY ("labOrderId") REFERENCES "LabOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;