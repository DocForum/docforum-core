-- DropForeignKey
ALTER TABLE "PatientProfile" DROP CONSTRAINT "PatientProfile_userId_fkey";

-- AlterTable
ALTER TABLE "PatientProfile" ADD COLUMN     "anonymizedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "PatientProfile" ADD CONSTRAINT "PatientProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

