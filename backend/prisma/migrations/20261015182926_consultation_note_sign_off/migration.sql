-- AlterTable
ALTER TABLE "Consultation" ADD COLUMN     "doctorProfileId" TEXT NOT NULL,
ADD COLUMN     "signedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ConsultationAddendum" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "authorDoctorProfileId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationAddendum_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsultationAddendum_consultationId_idx" ON "ConsultationAddendum"("consultationId");

-- CreateIndex
CREATE INDEX "Consultation_doctorProfileId_idx" ON "Consultation"("doctorProfileId");

-- CreateIndex
CREATE INDEX "Consultation_signedAt_idx" ON "Consultation"("signedAt");

-- AddForeignKey
ALTER TABLE "Consultation" ADD CONSTRAINT "Consultation_doctorProfileId_fkey" FOREIGN KEY ("doctorProfileId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationAddendum" ADD CONSTRAINT "ConsultationAddendum_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Consultation sign-off immutability (issue #64).
--
-- Application code already refuses to write a signed note (see
-- consultations/repositories: updates are scoped to `signedAt IS NULL`), but
-- that only binds callers who go through it. This trigger is the guarantee:
-- once `signedAt` is set, `notes`, `outcome` and `signedAt` itself cannot
-- change — including a direct `UPDATE` from Prisma, a psql session, or any
-- future module that forgets the rule. Corrections go in
-- `ConsultationAddendum`, which is append-only by construction.
--
-- Modelled on the same reasoning as hard rule 1 (never mutate an issued
-- Prescription/LabOrder) — clinical notes are legal records.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "prevent_signed_consultation_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."signedAt" IS NOT NULL AND (
       NEW."notes" IS DISTINCT FROM OLD."notes"
    OR NEW."outcome" IS DISTINCT FROM OLD."outcome"
    OR NEW."signedAt" IS DISTINCT FROM OLD."signedAt"
  ) THEN
    RAISE EXCEPTION 'Consultation % is signed off and immutable — add a ConsultationAddendum instead of editing it', OLD."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Consultation_signed_immutable"
  BEFORE UPDATE ON "Consultation"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_signed_consultation_mutation"();
