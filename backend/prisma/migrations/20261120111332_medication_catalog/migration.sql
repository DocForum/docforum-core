-- AlterTable
ALTER TABLE "PrescriptionItem" ADD COLUMN     "flaggedForPharmacistReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "medicationId" TEXT;

-- CreateTable
CREATE TABLE "Medication" (
    "id" TEXT NOT NULL,
    "genericName" TEXT NOT NULL,
    "strength" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "externalCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Medication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Medication_externalCode_key" ON "Medication"("externalCode");

-- CreateIndex
CREATE UNIQUE INDEX "Medication_genericName_strength_form_route_key" ON "Medication"("genericName", "strength", "form", "route");

-- CreateIndex
CREATE INDEX "PrescriptionItem_medicationId_idx" ON "PrescriptionItem"("medicationId");

-- AddForeignKey
ALTER TABLE "PrescriptionItem" ADD CONSTRAINT "PrescriptionItem_medicationId_fkey" FOREIGN KEY ("medicationId") REFERENCES "Medication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Issue #69: autocomplete search over tens of thousands of rows must not be
-- a sequential scan. `pg_trgm` is a trusted extension since PostgreSQL 13,
-- so the database owner can install it even on a managed host (Render
-- included); the GIN trigram index backs both `ILIKE '%q%'` and the
-- similarity-based ordering in medications/repositories. Prisma can't
-- express an operator-class index, so it lives here rather than in the
-- schema file. Measured in tests/integration/medications.test.mts.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Medication_genericName_trgm_idx" ON "Medication" USING GIN ("genericName" gin_trgm_ops);

