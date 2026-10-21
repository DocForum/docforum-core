CREATE TABLE "IntakeForm" (
    "id" TEXT NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "symptoms" JSONB NOT NULL,
    "freeTextNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntakeForm_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IntakeForm_patientProfileId_createdAt_idx"
ON "IntakeForm"("patientProfileId", "createdAt");

ALTER TABLE "IntakeForm"
ADD CONSTRAINT "IntakeForm_patientProfileId_fkey"
FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
