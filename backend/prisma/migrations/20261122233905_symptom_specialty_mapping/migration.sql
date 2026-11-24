-- CreateTable
CREATE TABLE "Symptom" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isRetired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Symptom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SymptomSpecialty" (
    "id" TEXT NOT NULL,
    "symptomId" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SymptomSpecialty_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Symptom_name_key" ON "Symptom"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Symptom_slug_key" ON "Symptom"("slug");

-- CreateIndex
CREATE INDEX "Symptom_name_trgm_idx" ON "Symptom" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "SymptomSpecialty_specialtyId_idx" ON "SymptomSpecialty"("specialtyId");

-- CreateIndex
CREATE UNIQUE INDEX "SymptomSpecialty_symptomId_specialtyId_key" ON "SymptomSpecialty"("symptomId", "specialtyId");

-- AddForeignKey
ALTER TABLE "SymptomSpecialty" ADD CONSTRAINT "SymptomSpecialty_symptomId_fkey" FOREIGN KEY ("symptomId") REFERENCES "Symptom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SymptomSpecialty" ADD CONSTRAINT "SymptomSpecialty_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Mapping strength is 1 (weak) .. 5 (strong). Prisma's schema DSL cannot
-- express a check constraint, so it lives here; the API validates the same
-- range and a hand-written row cannot invent a different scale.
ALTER TABLE "SymptomSpecialty"
  ADD CONSTRAINT "SymptomSpecialty_weight_range" CHECK ("weight" BETWEEN 1 AND 5);

-- Reviewed starter vocabulary (issue #60). Deliberately small and
-- non-clinical: each row is a pointer from a plain-language complaint to an
-- existing specialty. Specialties are resolved by slug (they are seeded by
-- 20261021090000_doctor_discovery_trigram_search), so a database where a
-- specialty is missing simply gets no row for it instead of a broken FK.
INSERT INTO "Symptom" ("id", "name", "slug", "updatedAt") VALUES
  ('a6070218-17b0-49b0-9273-534ade40e4db', 'Rash', 'rash', CURRENT_TIMESTAMP),
  ('96eea385-149b-45f9-861b-1ab2420365c9', 'Acne', 'acne', CURRENT_TIMESTAMP),
  ('5075f1a7-4ddc-46bb-89b4-c03be78b992d', 'Itchy skin', 'itchy-skin', CURRENT_TIMESTAMP),
  ('25b8313a-2f1f-4b3b-96a5-abc10b922e00', 'Chest pain', 'chest-pain', CURRENT_TIMESTAMP),
  ('79abed12-32b8-4194-85d7-b7895a04d316', 'Palpitations', 'palpitations', CURRENT_TIMESTAMP),
  ('10abd394-0fd6-42fe-aa74-05c96195b5ec', 'High blood pressure', 'high-blood-pressure', CURRENT_TIMESTAMP),
  ('8dc4cb39-77e8-4a8e-93ea-bcb96d9122af', 'Shortness of breath', 'shortness-of-breath', CURRENT_TIMESTAMP),
  ('5ae8f777-2ac8-4a53-a0da-493fd160012b', 'Cough', 'cough', CURRENT_TIMESTAMP),
  ('b9b04b4a-90f9-4c17-bb29-bd8c876791d9', 'Fever', 'fever', CURRENT_TIMESTAMP),
  ('8328f7a9-9a39-438c-bdaa-a00f8445ddbb', 'Headache', 'headache', CURRENT_TIMESTAMP),
  ('0203ec29-ceec-47a3-8bd0-83b109ea1486', 'Joint pain', 'joint-pain', CURRENT_TIMESTAMP),
  ('5e2b59d2-bdd6-4c52-97dc-61dd30af8f20', 'Annual check-up', 'annual-check-up', CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

INSERT INTO "SymptomSpecialty" ("id", "symptomId", "specialtyId", "weight")
SELECT mapping.id, symptom.id, specialty.id, mapping.weight
FROM (VALUES
  ('6d09ce8a-53d2-4803-999f-ec677c0a166d', 'rash', 'dermatology', 5),
  ('3616ecb9-1d80-4129-9e31-c69b766ba641', 'rash', 'family-medicine', 2),
  ('d22e558d-5c56-4a6e-b5c1-7d84275b356d', 'acne', 'dermatology', 5),
  ('3bdab39c-0d1c-45da-aaa8-569f249f6d71', 'itchy-skin', 'dermatology', 5),
  ('286aebcf-444a-4858-bb33-a0673a03ec14', 'itchy-skin', 'family-medicine', 2),
  ('c56d97fc-4e0b-432a-abb4-30a41c4e3643', 'chest-pain', 'cardiology', 5),
  ('6496d9c6-3e75-41df-ac75-1654a7a43fb7', 'chest-pain', 'family-medicine', 2),
  ('51370e69-9fd2-47d8-aaf4-1b4258287286', 'palpitations', 'cardiology', 4),
  ('33ca0e4d-9788-4b8a-9ed5-1ed785cd189f', 'palpitations', 'family-medicine', 2),
  ('b580bfc2-66ea-4e77-bde7-ab076cf36159', 'high-blood-pressure', 'cardiology', 4),
  ('f1c9d572-80d6-4853-8f1d-de4b0e2cae5c', 'high-blood-pressure', 'family-medicine', 3),
  ('88736b19-ba97-42d0-89d0-11a131565ece', 'shortness-of-breath', 'cardiology', 3),
  ('a6070218-17b0-49b0-9273-534ade40e4dc', 'shortness-of-breath', 'family-medicine', 2),
  ('96eea385-149b-45f9-861b-1ab2420365ca', 'cough', 'family-medicine', 5),
  ('5075f1a7-4ddc-46bb-89b4-c03be78b992e', 'fever', 'family-medicine', 4),
  ('25b8313a-2f1f-4b3b-96a5-abc10b922e01', 'headache', 'family-medicine', 3),
  ('79abed12-32b8-4194-85d7-b7895a04d317', 'joint-pain', 'family-medicine', 3),
  ('10abd394-0fd6-42fe-aa74-05c96195b5ed', 'annual-check-up', 'family-medicine', 5)
) AS mapping(id, symptom_slug, specialty_slug, weight)
JOIN "Symptom" AS symptom ON symptom."slug" = mapping.symptom_slug
JOIN "Specialty" AS specialty ON specialty."slug" = mapping.specialty_slug
ON CONFLICT DO NOTHING;
