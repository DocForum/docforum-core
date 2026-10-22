-- Issue #127: facility price lists used to price PaymentIntents.
--
-- Versioned (append-only) prices: a price change is a new row with a later
-- "effectiveFrom", so historical intents keep their original amount and the
-- list stays auditable. Amounts are stroops (BIGINT), matching PaymentIntent.

CREATE TABLE "FacilityPrice" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "catalogItemCode" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacilityPrice_pkey" PRIMARY KEY ("id")
);

-- Two versions of the same item/asset cannot share an effective instant.
CREATE UNIQUE INDEX "FacilityPrice_facilityId_catalogItemCode_asset_effectiveFrom_key"
    ON "FacilityPrice"("facilityId", "catalogItemCode", "asset", "effectiveFrom");

-- Current-price lookup for one facility.
CREATE INDEX "FacilityPrice_facilityId_catalogItemCode_asset_effectiveFrom_idx"
    ON "FacilityPrice"("facilityId", "catalogItemCode", "asset", "effectiveFrom");

-- Eligible-facility lookup: current price per facility for a catalog item.
CREATE INDEX "FacilityPrice_catalogItemCode_asset_effectiveFrom_idx"
    ON "FacilityPrice"("catalogItemCode", "asset", "effectiveFrom");

ALTER TABLE "FacilityPrice" ADD CONSTRAINT "FacilityPrice_facilityId_fkey"
    FOREIGN KEY ("facilityId") REFERENCES "FacilityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which price list entry priced an intent (the amount is the snapshot).
ALTER TABLE "PaymentIntent" ADD COLUMN "catalogItemCode" TEXT;
