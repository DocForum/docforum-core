-- Feature flags (Phase 8, issue #132).

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rolloutPercent" INTEGER NOT NULL DEFAULT 100,
    "allowRoles" "Role"[] DEFAULT ARRAY[]::"Role"[],
    "allowUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);

-- A percentage is a percentage, whatever wrote the row.
ALTER TABLE "FeatureFlag" ADD CONSTRAINT "FeatureFlag_rolloutPercent_range" CHECK ("rolloutPercent" BETWEEN 0 AND 100);

-- First flag (ADR 0005): the patient-wallet funding mode launches as an
-- option, off until an admin turns it on.
INSERT INTO "FeatureFlag" ("key", "description", "enabled", "rolloutPercent", "updatedAt")
VALUES ('payments.wallet_funding', 'Patient-wallet funding mode (ADR 0005): POST /payments/intents/:id/prepare', false, 100, CURRENT_TIMESTAMP);
