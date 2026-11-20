-- Phase 4, issue #72 (PRD §8.2.7): abnormal lab result escalation and doctor
-- acknowledgement tracking.

-- How serious the fulfilling facility judged the result. Existing rows were
-- never judged, so they take the `normal` default rather than being invented
-- as abnormal.
CREATE TYPE "LabResultAbnormality" AS ENUM ('normal', 'abnormal', 'critical');

ALTER TABLE "LabResult"
  ADD COLUMN "abnormality" "LabResultAbnormality" NOT NULL DEFAULT 'normal';

-- The acknowledgement task (one per result). Created with the result for
-- abnormal/critical rows only; `acknowledgedAt` and `escalatedAt` are each
-- written at most once by a conditional UPDATE.
CREATE TABLE "LabResultAcknowledgement" (
    "id" TEXT NOT NULL,
    "labResultId" TEXT NOT NULL,
    "orderingDoctorId" TEXT NOT NULL,
    "severity" "LabResultAbnormality" NOT NULL,
    "escalationDueAt" TIMESTAMP(3) NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByDoctorId" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabResultAcknowledgement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LabResultAcknowledgement_labResultId_key" ON "LabResultAcknowledgement"("labResultId");
CREATE INDEX "LabResultAcknowledgement_acknowledgedAt_escalationDueAt_idx" ON "LabResultAcknowledgement"("acknowledgedAt", "escalationDueAt");
CREATE INDEX "LabResultAcknowledgement_orderingDoctorId_acknowledgedAt_idx" ON "LabResultAcknowledgement"("orderingDoctorId", "acknowledgedAt");

ALTER TABLE "LabResultAcknowledgement"
  ADD CONSTRAINT "LabResultAcknowledgement_labResultId_fkey"
  FOREIGN KEY ("labResultId") REFERENCES "LabResult"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LabResultAcknowledgement"
  ADD CONSTRAINT "LabResultAcknowledgement_orderingDoctorId_fkey"
  FOREIGN KEY ("orderingDoctorId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
