-- AlterEnum
ALTER TYPE "ReferralStatus" ADD VALUE 'cancelled';

-- DropForeignKey
ALTER TABLE "Appointment" DROP CONSTRAINT "Appointment_availabilitySlotId_fkey";

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "referralId" TEXT,
ALTER COLUMN "availabilitySlotId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Consultation" ADD COLUMN     "appointmentId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

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

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "referralId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEvent_referralId_idx" ON "AuditEvent"("referralId");

-- CreateIndex
CREATE INDEX "AuditEvent_action_idx" ON "AuditEvent"("action");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Consultation_appointmentId_key" ON "Consultation"("appointmentId");

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
ALTER TABLE "Consultation" ADD CONSTRAINT "Consultation_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE SET NULL ON UPDATE CASCADE;

