-- CreateTable
CREATE TABLE "Sep10Challenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sep10Challenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sep10Challenge_nonce_key" ON "Sep10Challenge"("nonce");

-- CreateIndex
CREATE INDEX "Sep10Challenge_expiresAt_idx" ON "Sep10Challenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "Sep10Challenge" ADD CONSTRAINT "Sep10Challenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

