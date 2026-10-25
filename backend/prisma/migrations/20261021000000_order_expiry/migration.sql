ALTER TABLE "LabOrder" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "LabOrder_status_expiresAt_idx" ON "LabOrder"("status","expiresAt");
