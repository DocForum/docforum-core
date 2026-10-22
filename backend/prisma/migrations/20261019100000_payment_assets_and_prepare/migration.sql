-- Issue #79: PaymentIntent is denominated in an allowlisted asset, not
-- implicitly native XLM. The amount column is renamed, not recreated, so
-- every existing row keeps its exact smallest-unit value (no data copy, no
-- precision loss). `assetCode` is backfilled to 'XLM' because that is the
-- only asset v1 could have created; `tokenContractId` stays NULL for those
-- rows and the service resolves it from ESCROW_TOKEN_ID (see schema comment).
ALTER TABLE "PaymentIntent" RENAME COLUMN "amountStroops" TO "amount";
ALTER TABLE "PaymentIntent" ADD COLUMN "assetCode" TEXT NOT NULL DEFAULT 'XLM';
ALTER TABLE "PaymentIntent" ADD COLUMN "tokenContractId" TEXT;
ALTER TABLE "PaymentIntent" ALTER COLUMN "assetCode" DROP DEFAULT;

-- Issue #80: prepare/expire state machine. `awaiting_signature` and
-- `submitting` are added to the status enum (submitting is reserved for the
-- submit half of ADR 0005 and not written yet).
ALTER TYPE "PaymentIntentStatus" ADD VALUE 'awaiting_signature';
ALTER TYPE "PaymentIntentStatus" ADD VALUE 'submitting';

ALTER TABLE "PaymentIntent" ADD COLUMN "preparedTxHash" TEXT;
ALTER TABLE "PaymentIntent" ADD COLUMN "preparedXdr" TEXT;
ALTER TABLE "PaymentIntent" ADD COLUMN "preparedExpiryLedger" INTEGER;
ALTER TABLE "PaymentIntent" ADD COLUMN "preparedExpiresAt" TIMESTAMP(3);
ALTER TABLE "PaymentIntent" ADD COLUMN "refundAfter" TIMESTAMP(3);

-- Expiry sweep: find live prepared transactions whose window has passed.
CREATE INDEX "PaymentIntent_status_preparedExpiresAt_idx" ON "PaymentIntent"("status", "preparedExpiresAt");

-- ADR 0005 step 1: patient payer wallet link (SEP-10 verified once that
-- flow exists). Separate from WalletLink, which stays the facility payee.
CREATE TABLE "PatientWalletLink" (
    "id" TEXT NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "stellarPublicKey" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientWalletLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PatientWalletLink_patientProfileId_key" ON "PatientWalletLink"("patientProfileId");

ALTER TABLE "PatientWalletLink" ADD CONSTRAINT "PatientWalletLink_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
