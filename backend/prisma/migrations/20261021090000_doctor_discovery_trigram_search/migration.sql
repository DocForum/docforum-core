CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "DoctorProfile_fullName_trgm_idx"
  ON "DoctorProfile" USING GIN ("fullName" gin_trgm_ops);

CREATE INDEX "Specialty_name_trgm_idx"
  ON "Specialty" USING GIN ("name" gin_trgm_ops);

INSERT INTO "Specialty" ("id", "name", "slug") VALUES
  ('00000000-0000-4000-8000-000000000023', 'Cardiology', 'cardiology'),
  ('00000000-0000-4000-8000-000000000024', 'Dermatology', 'dermatology'),
  ('00000000-0000-4000-8000-000000000025', 'Family Medicine', 'family-medicine')
ON CONFLICT DO NOTHING;
