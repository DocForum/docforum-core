-- AlterTable
ALTER TABLE "DoctorSpecialty" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Specialty" ADD COLUMN     "isRetired" BOOLEAN NOT NULL DEFAULT false;

