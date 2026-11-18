-- The initial migration created an empty IntakeForm placeholder. Extend it
-- instead of creating the relation a second time.
ALTER TABLE "IntakeForm"
ADD COLUMN "patientProfileId" TEXT,
ADD COLUMN "symptoms" JSONB,
ADD COLUMN "freeTextNotes" TEXT;

ALTER TABLE "IntakeForm"
ALTER COLUMN "patientProfileId" SET NOT NULL,
ALTER COLUMN "symptoms" SET NOT NULL;

CREATE INDEX "IntakeForm_patientProfileId_createdAt_idx"
ON "IntakeForm"("patientProfileId", "createdAt");

ALTER TABLE "IntakeForm"
ADD CONSTRAINT "IntakeForm_patientProfileId_fkey"
FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
