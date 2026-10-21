CREATE TYPE "EscrowChainEventState" AS ENUM ('pending', 'matched', 'unmatched');

CREATE TABLE "EscrowEventCursor" (
  "contractId" TEXT NOT NULL,
  "startLedger" INTEGER NOT NULL,
  "cursor" TEXT,
  "lastLedger" INTEGER,
  "catchupError" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EscrowEventCursor_pkey" PRIMARY KEY ("contractId")
);

CREATE TABLE "EscrowChainEvent" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "ledger" INTEGER NOT NULL,
  "txHash" TEXT,
  "escrowId" BIGINT,
  "eventType" TEXT NOT NULL,
  "state" "EscrowChainEventState" NOT NULL DEFAULT 'pending',
  "paymentIntentId" TEXT,
  "payload" JSONB,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "alertedAt" TIMESTAMP(3),
  CONSTRAINT "EscrowChainEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EscrowChainEvent_contractId_eventId_key" UNIQUE ("contractId", "eventId")
);
CREATE INDEX "EscrowChainEvent_state_detectedAt_idx" ON "EscrowChainEvent"("state", "detectedAt");
CREATE INDEX "EscrowChainEvent_contractId_ledger_idx" ON "EscrowChainEvent"("contractId", "ledger");
