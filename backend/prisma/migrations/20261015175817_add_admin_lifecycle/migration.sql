-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "sessionsInvalidatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AdminInvite" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invitedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminInvite_tokenHash_key" ON "AdminInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminInvite_email_idx" ON "AdminInvite"("email");

-- AddForeignKey
ALTER TABLE "AdminInvite" ADD CONSTRAINT "AdminInvite_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
