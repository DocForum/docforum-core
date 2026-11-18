-- Phase 5, issue #16 (docs/adr/0014): lab result files live in object
-- storage; the row keeps only the opaque object key and file metadata.
ALTER TABLE "LabResult"
  ADD COLUMN "resultObjectKey" TEXT,
  ADD COLUMN "resultContentType" TEXT,
  ADD COLUMN "resultByteSize" INTEGER;

CREATE UNIQUE INDEX "LabResult_resultObjectKey_key" ON "LabResult"("resultObjectKey");
