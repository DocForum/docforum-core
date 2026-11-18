-- Optimistic concurrency for mutable records (Phase 8, issue #49).
--
-- One integer per row, defaulting to 1 so existing rows are valid at their
-- current state without a backfill. It is the storage half of the ETag/If-Match
-- convention in ARCHITECTURE.md §5.4 and is meaningless on its own: nothing may
-- compare-then-write, the compare has to live in the UPDATE's WHERE clause.
--
-- Deliberately NOT added to Prescription/LabOrder (append-only — a correction is
-- a new row, so there is no update to lose) or to immutable tables
-- (AvailabilitySlot, Specialty, WalletLink, AuditEvent, the export tables).

-- AlterTable
ALTER TABLE "User" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "PatientProfile" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "DoctorProfile" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "FacilityProfile" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "FacilityCapability" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "PaymentIntent" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;