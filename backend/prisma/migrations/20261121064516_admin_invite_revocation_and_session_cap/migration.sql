-- AlterTable
ALTER TABLE "AdminInvite" ADD COLUMN     "revokedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RefreshSession" ADD COLUMN     "revokedReason" TEXT;

-- CreateIndex
CREATE INDEX "User_email_prefix_idx" ON "User"("email" text_pattern_ops);

