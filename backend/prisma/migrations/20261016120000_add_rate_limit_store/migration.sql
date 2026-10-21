-- CreateTable
CREATE TABLE "RateLimitRecord" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL, // 'user' | 'ip'
    "cost" INTEGER NOT NULL DEFAULT 1,
    "consumedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimitRecord_key_scope_idx" ON "RateLimitRecord"("key", "scope");

-- CreateIndex
CREATE INDEX "RateLimitRecord_consumedAt_idx" ON "RateLimitRecord"("consumedAt");

-- Backfill: existing LoginAttempt rows are already tracked; no-op for new repo