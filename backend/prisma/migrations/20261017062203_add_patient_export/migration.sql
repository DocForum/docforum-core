-- CreateEnum
CREATE TYPE "PatientExportStatus" AS ENUM ('pending', 'processing', 'ready', 'failed', 'expired');

-- CreateTable
CREATE TABLE "PatientExport" (
    "id" TEXT NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "status" "PatientExportStatus" NOT NULL DEFAULT 'pending',
    "schemaVersion" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "generatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "sizeBytes" INTEGER,
    "chunkCount" INTEGER,
    "failureCode" TEXT,
    "failedSection" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientExportChunk" (
    "exportId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "data" TEXT NOT NULL,

    CONSTRAINT "PatientExportChunk_pkey" PRIMARY KEY ("exportId","attempt","seq")
);

-- CreateIndex
CREATE INDEX "PatientExport_patientProfileId_createdAt_idx" ON "PatientExport"("patientProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "PatientExport_status_expiresAt_idx" ON "PatientExport"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "PatientExport" ADD CONSTRAINT "PatientExport_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientExportChunk" ADD CONSTRAINT "PatientExportChunk_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "PatientExport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

