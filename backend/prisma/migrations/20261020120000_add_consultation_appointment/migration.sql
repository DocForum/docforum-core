-- Phase 2, issue #4: a Consultation is now a real record, tied 1:1 to an Appointment.
--
-- The table has existed since the Phase 0 scaffold as (id, outcome?, notes,
-- createdAt) with nothing relating it to anything, and nothing has ever
-- written to it (`POST /appointments/:id/consultation` is the first writer).
-- So tightening `outcome` to NOT NULL and adding a NOT NULL FK needs no
-- backfill. If an environment does hold scaffold rows, this migration fails
-- loudly rather than inventing an outcome and an appointment for them —
-- inspect and remove them first.
--
-- `Consultation_appointmentId_key` is the guarantee, not an optimisation:
-- "a consultation can only be closed once" is the unique constraint refusing
-- the second INSERT, not a read-then-write check in the service.

-- AlterTable
ALTER TABLE "Consultation" ADD COLUMN "appointmentId" TEXT NOT NULL,
ALTER COLUMN "outcome" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Consultation_appointmentId_key" ON "Consultation"("appointmentId");

-- AddForeignKey
ALTER TABLE "Consultation" ADD CONSTRAINT "Consultation_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
