-- CreateEnum
CREATE TYPE "ConsultationMessageSenderRole" AS ENUM ('patient', 'doctor');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('open', 'booked', 'expired');

-- AlterEnum
ALTER TYPE "AppointmentOrigin" ADD VALUE 'follow_up';

-- AlterTable
ALTER TABLE "Consultation" ADD COLUMN     "signedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ConsultationMessage" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "senderRole" "ConsultationMessageSenderRole" NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsultationMessageAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationMessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsultationAddendum" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationAddendum_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUpRequest" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "doctorProfileId" TEXT NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "notesSnapshot" TEXT,
    "intakeFormId" TEXT,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'open',
    "bookedAppointmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUpRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsultationMessage_consultationId_createdAt_id_idx" ON "ConsultationMessage"("consultationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ConsultationMessage_senderUserId_idx" ON "ConsultationMessage"("senderUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsultationMessageAttachment_objectKey_key" ON "ConsultationMessageAttachment"("objectKey");

-- CreateIndex
CREATE INDEX "ConsultationMessageAttachment_messageId_idx" ON "ConsultationMessageAttachment"("messageId");

-- CreateIndex
CREATE INDEX "ConsultationAddendum_consultationId_createdAt_id_idx" ON "ConsultationAddendum"("consultationId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FollowUpRequest_consultationId_key" ON "FollowUpRequest"("consultationId");

-- CreateIndex
CREATE UNIQUE INDEX "FollowUpRequest_bookedAppointmentId_key" ON "FollowUpRequest"("bookedAppointmentId");

-- CreateIndex
CREATE INDEX "FollowUpRequest_patientProfileId_status_idx" ON "FollowUpRequest"("patientProfileId", "status");

-- CreateIndex
CREATE INDEX "FollowUpRequest_doctorProfileId_status_idx" ON "FollowUpRequest"("doctorProfileId", "status");

-- CreateIndex
CREATE INDEX "FollowUpRequest_status_windowEnd_idx" ON "FollowUpRequest"("status", "windowEnd");

-- AddForeignKey
ALTER TABLE "ConsultationMessage" ADD CONSTRAINT "ConsultationMessage_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationMessage" ADD CONSTRAINT "ConsultationMessage_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationMessageAttachment" ADD CONSTRAINT "ConsultationMessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ConsultationMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationAddendum" ADD CONSTRAINT "ConsultationAddendum_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationAddendum" ADD CONSTRAINT "ConsultationAddendum_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpRequest" ADD CONSTRAINT "FollowUpRequest_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpRequest" ADD CONSTRAINT "FollowUpRequest_doctorProfileId_fkey" FOREIGN KEY ("doctorProfileId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpRequest" ADD CONSTRAINT "FollowUpRequest_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpRequest" ADD CONSTRAINT "FollowUpRequest_bookedAppointmentId_fkey" FOREIGN KEY ("bookedAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Append-only thread, attachments and addenda (Phase 2, issues #61/#62/#64).
-- The application has no update/delete path for these rows; the database
-- refuses one too, mirroring AuditEvent's enforcement. Mistakes are corrected
-- by a new message/addendum, never by rewriting history.
CREATE FUNCTION "consultation_thread_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "ConsultationMessage_no_update_delete"
  BEFORE UPDATE OR DELETE ON "ConsultationMessage"
  FOR EACH ROW EXECUTE FUNCTION "consultation_thread_reject_mutation"();
CREATE TRIGGER "ConsultationMessage_no_truncate"
  BEFORE TRUNCATE ON "ConsultationMessage"
  FOR EACH STATEMENT EXECUTE FUNCTION "consultation_thread_reject_mutation"();

CREATE TRIGGER "ConsultationMessageAttachment_no_update_delete"
  BEFORE UPDATE OR DELETE ON "ConsultationMessageAttachment"
  FOR EACH ROW EXECUTE FUNCTION "consultation_thread_reject_mutation"();
CREATE TRIGGER "ConsultationMessageAttachment_no_truncate"
  BEFORE TRUNCATE ON "ConsultationMessageAttachment"
  FOR EACH STATEMENT EXECUTE FUNCTION "consultation_thread_reject_mutation"();

CREATE TRIGGER "ConsultationAddendum_no_update_delete"
  BEFORE UPDATE OR DELETE ON "ConsultationAddendum"
  FOR EACH ROW EXECUTE FUNCTION "consultation_thread_reject_mutation"();
CREATE TRIGGER "ConsultationAddendum_no_truncate"
  BEFORE TRUNCATE ON "ConsultationAddendum"
  FOR EACH STATEMENT EXECUTE FUNCTION "consultation_thread_reject_mutation"();

-- Note sign-off (Phase 2, issue #64). Once signedAt is set the note text and
-- the sign-off itself are immutable, at the database level — not just in the
-- repository's conditional UPDATE. A correction is a new ConsultationAddendum.
CREATE FUNCTION "consultation_note_signed_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."signedAt" IS NOT NULL THEN
    IF NEW."notes" IS DISTINCT FROM OLD."notes" THEN
      RAISE EXCEPTION 'Consultation notes are immutable after sign-off'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."signedAt" IS DISTINCT FROM OLD."signedAt" THEN
      RAISE EXCEPTION 'Consultation sign-off is immutable once set'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Consultation_signed_note_immutable"
  BEFORE UPDATE ON "Consultation"
  FOR EACH ROW EXECUTE FUNCTION "consultation_note_signed_immutable"();

-- RLS UPDATE policy for the note workflow (Phase 2, issue #64). The
-- patient-row-level-security migration (issue #116) added SELECT + INSERT
-- policies for Consultation only; sign-off and note edits are UPDATEs, and
-- FORCE ROW LEVEL SECURITY with no UPDATE policy silently matches zero rows.
-- The service layer still enforces "authoring doctor only" — this policy is
-- the database half, scoped to the same doctor/admin roles the SELECT policy
-- already trusts.
CREATE POLICY "consultation_patient_scope_update" ON "Consultation" FOR UPDATE
  USING (current_setting('app.current_role', true) IN ('doctor', 'admin'))
  WITH CHECK (current_setting('app.current_role', true) IN ('doctor', 'admin'));
