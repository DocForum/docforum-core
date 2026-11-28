-- Phase 2, issue #131: admin-managed closure calendar that blocks slot
-- generation and removes already-open slots.
--
-- Hand-written but drift-checked: `node scripts/check-migration-drift.mjs`
-- applies it and diffs the result against prisma/schema/ (the generator script
-- could not spawn `npx` on Windows). The two CHECK constraints are the part
-- Prisma cannot express in the schema, and they are why the rows cannot
-- contradict themselves: a platform-wide closure can never point at a facility,
-- a facility closure always must, and a range can never be inverted.

-- CreateEnum
CREATE TYPE "ClosureScope" AS ENUM ('platform', 'facility');

-- CreateTable
CREATE TABLE "ClosurePeriod" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "scope" "ClosureScope" NOT NULL,
    "facilityProfileId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClosurePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClosurePeriod_startDate_endDate_idx" ON "ClosurePeriod"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "ClosurePeriod_scope_startDate_idx" ON "ClosurePeriod"("scope", "startDate");

-- CreateIndex
CREATE INDEX "ClosurePeriod_facilityProfileId_idx" ON "ClosurePeriod"("facilityProfileId");

-- AddForeignKey
ALTER TABLE "ClosurePeriod" ADD CONSTRAINT "ClosurePeriod_facilityProfileId_fkey" FOREIGN KEY ("facilityProfileId") REFERENCES "FacilityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Scope/facility consistency (cannot be expressed in the Prisma schema).
ALTER TABLE "ClosurePeriod" ADD CONSTRAINT "ClosurePeriod_scope_facility_check"
    CHECK (
        ("scope" = 'platform' AND "facilityProfileId" IS NULL)
        OR ("scope" = 'facility' AND "facilityProfileId" IS NOT NULL)
    );

-- An inclusive all-day range that cannot be inverted.
ALTER TABLE "ClosurePeriod" ADD CONSTRAINT "ClosurePeriod_range_check"
    CHECK ("startDate" <= "endDate");
