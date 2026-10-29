-- Phase 8, issue #116: explicit operational role for trusted maintenance
-- work. Request handlers do not SET ROLE to this role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docforum_app') THEN
    CREATE ROLE docforum_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docforum_rls_bypass') THEN
    CREATE ROLE docforum_rls_bypass NOLOGIN BYPASSRLS;
  END IF;
END
$$;
GRANT docforum_app TO CURRENT_USER;
GRANT docforum_rls_bypass TO CURRENT_USER;
-- Request transactions assume this non-owner role so even a privileged
-- connection string cannot silently skip RLS. It receives the existing
-- runtime table privileges; policies narrow only the protected tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO docforum_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO docforum_app;
-- BYPASSRLS is not a privilege grant: trusted jobs and test harnesses still
-- need ordinary SQL privileges on tables created by the migration owner.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO docforum_rls_bypass;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO docforum_rls_bypass;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO docforum_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO docforum_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO docforum_rls_bypass;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO docforum_rls_bypass;

-- Force policies for table owners too. The policy allows patient requests
-- only their own/guardian-owned rows; non-patient application roles retain
-- their service-authorized access. Jobs and migrations use the explicit
-- BYPASSRLS role.
ALTER TABLE "Appointment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Appointment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "appointment_patient_scope_select" ON "Appointment" FOR SELECT
  USING (
    current_setting('app.current_role', true) IN ('doctor', 'facility', 'admin')
    OR EXISTS (
      SELECT 1 FROM "PatientProfile" p
      WHERE p.id = "Appointment"."patientProfileId"
        AND (p."userId" = current_setting('app.current_user_id', true)
          OR EXISTS (
            SELECT 1 FROM "Guardianship" g
            WHERE g."dependentProfileId" = p.id
              AND g."guardianUserId" = current_setting('app.current_user_id', true)
              AND g."revokedAt" IS NULL
          ))
    )
  );
CREATE POLICY "appointment_patient_scope_insert" ON "Appointment" FOR INSERT
  WITH CHECK (
    current_setting('app.current_role', true) IN ('doctor', 'facility', 'admin')
    OR EXISTS (
      SELECT 1 FROM "PatientProfile" p
      WHERE p.id = "Appointment"."patientProfileId"
        AND (p."userId" = current_setting('app.current_user_id', true)
          OR EXISTS (
            SELECT 1 FROM "Guardianship" g
            WHERE g."dependentProfileId" = p.id
              AND g."guardianUserId" = current_setting('app.current_user_id', true)
              AND g."revokedAt" IS NULL
          ))
    )
  );
CREATE POLICY "appointment_patient_scope_update" ON "Appointment" FOR UPDATE
  USING (
    current_setting('app.current_role', true) IN ('doctor', 'facility', 'admin')
    OR EXISTS (
      SELECT 1 FROM "PatientProfile" p
      WHERE p.id = "Appointment"."patientProfileId"
        AND (p."userId" = current_setting('app.current_user_id', true)
          OR EXISTS (
            SELECT 1 FROM "Guardianship" g
            WHERE g."dependentProfileId" = p.id
              AND g."guardianUserId" = current_setting('app.current_user_id', true)
              AND g."revokedAt" IS NULL
          ))
    )
  )
  WITH CHECK (
    current_setting('app.current_role', true) IN ('doctor', 'facility', 'admin')
    OR EXISTS (
      SELECT 1 FROM "PatientProfile" p
      WHERE p.id = "Appointment"."patientProfileId"
        AND (p."userId" = current_setting('app.current_user_id', true)
          OR EXISTS (
            SELECT 1 FROM "Guardianship" g
            WHERE g."dependentProfileId" = p.id
              AND g."guardianUserId" = current_setting('app.current_user_id', true)
              AND g."revokedAt" IS NULL
          ))
    )
  );
CREATE POLICY "appointment_patient_scope_delete" ON "Appointment" FOR DELETE
  USING (
    current_setting('app.current_role', true) IN ('doctor', 'facility', 'admin')
    OR EXISTS (
      SELECT 1 FROM "PatientProfile" p
      WHERE p.id = "Appointment"."patientProfileId"
        AND (p."userId" = current_setting('app.current_user_id', true)
          OR EXISTS (
            SELECT 1 FROM "Guardianship" g
            WHERE g."dependentProfileId" = p.id
              AND g."guardianUserId" = current_setting('app.current_user_id', true)
              AND g."revokedAt" IS NULL
          ))
    )
  );

-- Payment intents are patient-scoped in the same way. Four explicit
-- policies keep writes from changing ownership as well as reads scoped.
ALTER TABLE "PaymentIntent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentIntent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "payment_intent_patient_scope_select" ON "PaymentIntent" FOR SELECT
  USING (
    current_setting('app.current_role', true) IN ('doctor', 'facility', 'admin')
    OR EXISTS (
      SELECT 1 FROM "PatientProfile" p
      WHERE p.id = "PaymentIntent"."patientProfileId"
        AND (p."userId" = current_setting('app.current_user_id', true)
          OR EXISTS (
            SELECT 1 FROM "Guardianship" g
            WHERE g."dependentProfileId" = p.id
              AND g."guardianUserId" = current_setting('app.current_user_id', true)
              AND g."revokedAt" IS NULL
          ))
    )
  );
CREATE POLICY "payment_intent_patient_scope_insert" ON "PaymentIntent" FOR INSERT
  WITH CHECK (
    current_setting('app.current_role', true) IN ('doctor', 'facility', 'admin')
    OR EXISTS (
      SELECT 1 FROM "PatientProfile" p
      WHERE p.id = "PaymentIntent"."patientProfileId"
        AND (p."userId" = current_setting('app.current_user_id', true)
          OR EXISTS (
            SELECT 1 FROM "Guardianship" g
            WHERE g."dependentProfileId" = p.id
              AND g."guardianUserId" = current_setting('app.current_user_id', true)
              AND g."revokedAt" IS NULL
          ))
    )
  );
CREATE POLICY "payment_intent_patient_scope_update" ON "PaymentIntent" FOR UPDATE
  USING (
    current_setting('app.current_role', true) IN ('doctor', 'facility', 'admin')
    OR EXISTS (
      SELECT 1 FROM "PatientProfile" p
      WHERE p.id = "PaymentIntent"."patientProfileId"
        AND (p."userId" = current_setting('app.current_user_id', true)
          OR EXISTS (
            SELECT 1 FROM "Guardianship" g
            WHERE g."dependentProfileId" = p.id
              AND g."guardianUserId" = current_setting('app.current_user_id', true)
              AND g."revokedAt" IS NULL
          ))
    )
  )
  WITH CHECK (
    current_setting('app.current_role', true) IN ('doctor', 'facility', 'admin')
    OR EXISTS (
      SELECT 1 FROM "PatientProfile" p
      WHERE p.id = "PaymentIntent"."patientProfileId"
        AND (p."userId" = current_setting('app.current_user_id', true)
          OR EXISTS (
            SELECT 1 FROM "Guardianship" g
            WHERE g."dependentProfileId" = p.id
              AND g."guardianUserId" = current_setting('app.current_user_id', true)
              AND g."revokedAt" IS NULL
          ))
    )
  );
CREATE POLICY "payment_intent_patient_scope_delete" ON "PaymentIntent" FOR DELETE
  USING (
    current_setting('app.current_role', true) IN ('doctor', 'facility', 'admin')
    OR EXISTS (
      SELECT 1 FROM "PatientProfile" p
      WHERE p.id = "PaymentIntent"."patientProfileId"
        AND (p."userId" = current_setting('app.current_user_id', true)
          OR EXISTS (
            SELECT 1 FROM "Guardianship" g
            WHERE g."dependentProfileId" = p.id
              AND g."guardianUserId" = current_setting('app.current_user_id', true)
              AND g."revokedAt" IS NULL
          ))
    )
  );

-- Consultation has no patient id of its own; ownership is derived through
-- its appointment, preserving the existing data model.
ALTER TABLE "Consultation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Consultation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "consultation_patient_scope_select" ON "Consultation" FOR SELECT
  USING (
    current_setting('app.current_role', true) IN ('doctor', 'facility', 'admin')
    OR EXISTS (
      SELECT 1 FROM "Appointment" a
      JOIN "PatientProfile" p ON p.id = a."patientProfileId"
      WHERE a.id = "Consultation"."appointmentId"
        AND (p."userId" = current_setting('app.current_user_id', true)
          OR EXISTS (
            SELECT 1 FROM "Guardianship" g
            WHERE g."dependentProfileId" = p.id
              AND g."guardianUserId" = current_setting('app.current_user_id', true)
              AND g."revokedAt" IS NULL
          ))
    )
  );
CREATE POLICY "consultation_patient_scope_insert" ON "Consultation" FOR INSERT
  WITH CHECK (
    current_setting('app.current_role', true) IN ('doctor', 'admin')
  );
