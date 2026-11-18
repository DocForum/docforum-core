-- Issue #64: consultation note sign-off with append-only addenda.
--
-- `Consultation.signedAt` null = editable, non-null = immutable note (addenda
-- only). `Appointment.completedAt` is the instant the auto sign-off sweep
-- measures its delay from.

ALTER TABLE "Appointment" ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "Consultation" ADD COLUMN "signedAt" TIMESTAMP(3);

-- Both tables are under FORCE ROW LEVEL SECURITY (docs/adr/0014), so the
-- migration owner cannot backfill them without switching to the trusted
-- maintenance role. RESET ROLE restores the migration owner for the DDL below.
SET ROLE docforum_rls_bypass;

-- Existing completed appointments: their last write was the status change
-- that completed them, so updatedAt is the best available completion time.
UPDATE "Appointment" SET "completedAt" = "updatedAt" WHERE "status" = 'completed';

-- Existing consultations were created through the close routes and represent
-- signed legal records under the old model. Treating them as unsigned would
-- reopen every historical note for editing, so backfill the timestamp.
UPDATE "Consultation" SET "signedAt" = "createdAt";

RESET ROLE;

CREATE INDEX "Consultation_signedAt_idx" ON "Consultation"("signedAt");

-- CreateTable
CREATE TABLE "ConsultationAddendum" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "authorDoctorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationAddendum_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsultationAddendum_consultationId_createdAt_idx" ON "ConsultationAddendum"("consultationId", "createdAt");

-- CreateIndex
CREATE INDEX "ConsultationAddendum_authorDoctorId_idx" ON "ConsultationAddendum"("authorDoctorId");

-- AddForeignKey
ALTER TABLE "ConsultationAddendum" ADD CONSTRAINT "ConsultationAddendum_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationAddendum" ADD CONSTRAINT "ConsultationAddendum_authorDoctorId_fkey" FOREIGN KEY ("authorDoctorId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS (docs/adr/0014): the patient-row-level-security migration gave
-- Consultation SELECT and INSERT policies only. Editing/signing a note is an
-- UPDATE, so the treating doctor needs this policy or the conditional UPDATE
-- matches zero rows under docforum_app. WITH CHECK repeats the USING clause
-- so a row cannot be moved out of the doctor's own scope either.
CREATE POLICY "consultation_treating_doctor_update" ON "Consultation" FOR UPDATE
  USING (
    current_setting('app.current_role', true) = 'doctor'
    AND EXISTS (
      SELECT 1 FROM "Appointment" a
      JOIN "DoctorProfile" d ON d.id = a."doctorProfileId"
      WHERE a.id = "Consultation"."appointmentId"
        AND d."userId" = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.current_role', true) = 'doctor'
    AND EXISTS (
      SELECT 1 FROM "Appointment" a
      JOIN "DoctorProfile" d ON d.id = a."doctorProfileId"
      WHERE a.id = "Consultation"."appointmentId"
        AND d."userId" = current_setting('app.current_user_id', true)
    )
  );

-- Addenda are patient-linked clinical records, so they get the same RLS
-- treatment as the consultation they belong to: visibility follows the
-- underlying appointment, writes are doctor-only, and the trusted maintenance
-- role bypasses it (docs/adr/0014).
ALTER TABLE "ConsultationAddendum" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConsultationAddendum" FORCE ROW LEVEL SECURITY;
CREATE POLICY "consultation_addendum_patient_scope_select" ON "ConsultationAddendum" FOR SELECT
  USING (
    current_setting('app.current_role', true) IN ('doctor', 'facility', 'admin')
    OR EXISTS (
      SELECT 1 FROM "Consultation" c
      JOIN "Appointment" a ON a.id = c."appointmentId"
      JOIN "PatientProfile" p ON p.id = a."patientProfileId"
      WHERE c.id = "ConsultationAddendum"."consultationId"
        AND (p."userId" = current_setting('app.current_user_id', true)
          OR EXISTS (
            SELECT 1 FROM "Guardianship" g
            WHERE g."dependentProfileId" = p.id
              AND g."guardianUserId" = current_setting('app.current_user_id', true)
              AND g."revokedAt" IS NULL
          ))
    )
  );
CREATE POLICY "consultation_addendum_doctor_insert" ON "ConsultationAddendum" FOR INSERT
  WITH CHECK (
    current_setting('app.current_role', true) IN ('doctor', 'admin')
  );
CREATE POLICY "consultation_addendum_rls_bypass" ON "ConsultationAddendum"
  TO docforum_rls_bypass USING (true) WITH CHECK (true);

-- Sign-off immutability, enforced in the database as well as the repository
-- (definition of done for issue #64: a direct Prisma UPDATE of a signed note
-- must fail). Once signedAt is set, `notes` can never change again, sign-off
-- can never be cleared or re-dated, and the outcome is frozen with the note.
CREATE FUNCTION "consultation_reject_signed_note_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."signedAt" IS NOT NULL THEN
    IF NEW."signedAt" IS DISTINCT FROM OLD."signedAt" THEN
      RAISE EXCEPTION 'Consultation sign-off is immutable: signedAt cannot change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."notes" IS DISTINCT FROM OLD."notes" THEN
      RAISE EXCEPTION 'Consultation notes are immutable after sign-off; add an addendum instead'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."outcome" IS DISTINCT FROM OLD."outcome" THEN
      RAISE EXCEPTION 'Consultation outcome is immutable after sign-off'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Consultation_reject_signed_note_mutation"
  BEFORE UPDATE ON "Consultation"
  FOR EACH ROW EXECUTE FUNCTION "consultation_reject_signed_note_mutation"();

-- Addenda are append-only, same shape as AuditEvent: row-level UPDATE/DELETE
-- and statement-level TRUNCATE. A future retention policy must drop/recreate
-- these triggers in its own reviewed migration.
CREATE FUNCTION "consultation_addendum_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ConsultationAddendum is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "ConsultationAddendum_no_update_delete"
  BEFORE UPDATE OR DELETE ON "ConsultationAddendum"
  FOR EACH ROW EXECUTE FUNCTION "consultation_addendum_reject_mutation"();

CREATE TRIGGER "ConsultationAddendum_no_truncate"
  BEFORE TRUNCATE ON "ConsultationAddendum"
  FOR EACH STATEMENT EXECUTE FUNCTION "consultation_addendum_reject_mutation"();
