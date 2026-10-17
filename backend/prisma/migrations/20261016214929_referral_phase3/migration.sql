-- Phase 3 referral core (issues #5/#65/#66/#67/#68).
--
-- Scope note: this migration only owns what Phase 3 actually adds. Two
-- things it used to add are owned by other migrations and are deliberately
-- NOT created here, because `prisma migrate deploy` runs them in timestamp
-- order and a duplicate column/index/table is a hard failure:
--   * "Consultation"."appointmentId" (+ its unique index and FK) is created
--     by 20261020000000_order_payment_intents (issue #9), which runs later.
--   * The "AuditEvent" table is created by 20261017212335_add_audit_event
--     (issue #43) — the one append-only audit trail in this schema. Referral
--     admin actions are written into it as `entity_type = 'Referral'` rows
--     through the audit module, not into a second table.

-- AlterEnum
ALTER TYPE "ReferralStatus" ADD VALUE 'cancelled';

-- DropForeignKey
ALTER TABLE "Appointment" DROP CONSTRAINT "Appointment_availabilitySlotId_fkey";

-- AlterTable
-- A CANCELLED appointment releases its slot back to `open` (referral
-- cascade / patient cancel), so the appointment must stop holding the
-- unique claim on the slot. The row keeps its history; only the slot link
-- is cleared. The booking guarantee itself is unchanged — the conditional
-- UPDATE on SlotStatus is what prevents double-booking.
ALTER TABLE "Appointment" ADD COLUMN     "referralId" TEXT,
ALTER COLUMN "availabilitySlotId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Consultation" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN     "cancelledReason" TEXT,
ADD COLUMN     "loopFlagReason" TEXT,
ADD COLUMN     "loopFlaggedAt" TIMESTAMP(3),
ADD COLUMN     "noShowCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "parentReferralId" TEXT,
ADD COLUMN     "patientProfileId" TEXT NOT NULL,
ADD COLUMN     "referringDoctorId" TEXT NOT NULL,
ADD COLUMN     "referringDoctorNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "resultingAppointmentId" TEXT,
ADD COLUMN     "sourceConsultationId" TEXT NOT NULL,
ADD COLUMN     "targetDoctorId" TEXT NOT NULL,
ADD COLUMN     "targetSpecialtyId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Referral_resultingAppointmentId_key" ON "Referral"("resultingAppointmentId");

-- CreateIndex
CREATE INDEX "Referral_patientProfileId_idx" ON "Referral"("patientProfileId");

-- CreateIndex
CREATE INDEX "Referral_referringDoctorId_idx" ON "Referral"("referringDoctorId");

-- CreateIndex
CREATE INDEX "Referral_targetDoctorId_idx" ON "Referral"("targetDoctorId");

-- CreateIndex
CREATE INDEX "Referral_status_idx" ON "Referral"("status");

-- CreateIndex
CREATE INDEX "Referral_loopFlaggedAt_idx" ON "Referral"("loopFlaggedAt");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_availabilitySlotId_fkey" FOREIGN KEY ("availabilitySlotId") REFERENCES "AvailabilitySlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_sourceConsultationId_fkey" FOREIGN KEY ("sourceConsultationId") REFERENCES "Consultation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referringDoctorId_fkey" FOREIGN KEY ("referringDoctorId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_targetDoctorId_fkey" FOREIGN KEY ("targetDoctorId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_parentReferralId_fkey" FOREIGN KEY ("parentReferralId") REFERENCES "Referral"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_resultingAppointmentId_fkey" FOREIGN KEY ("resultingAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
