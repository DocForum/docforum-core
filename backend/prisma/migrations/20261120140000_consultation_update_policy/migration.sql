-- Allow doctors and admins to update open consultations when recording the outcome
CREATE POLICY "consultation_patient_scope_update" ON "Consultation" FOR UPDATE
  USING (
    current_setting('app.current_role', true) IN ('doctor', 'admin')
  )
  WITH CHECK (
    current_setting('app.current_role', true) IN ('doctor', 'admin')
  );
