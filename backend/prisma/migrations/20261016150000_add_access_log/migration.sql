-- CreateTable
CREATE TABLE "AccessLog" (
    "id" TEXT NOT NULL,
    "accessedBy" TEXT,
    "patientProfileId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "route" TEXT,
    "detail" TEXT,
    "accessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessLog_accessedAt_idx" ON "AccessLog"("accessedAt");

-- CreateIndex
CREATE INDEX "AccessLog_accessedBy_idx" ON "AccessLog"("accessedBy");

-- CreateIndex
CREATE INDEX "AccessLog_patientProfileId_accessedAt_idx" ON "AccessLog"("patientProfileId", "accessedAt");

-- CreateIndex
CREATE INDEX "AccessLog_entityType_entityId_idx" ON "AccessLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "AccessLog" ADD CONSTRAINT "AccessLog_accessedBy_fkey" FOREIGN KEY ("accessedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessLog" ADD CONSTRAINT "AccessLog_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
