-- Issue #13 (docs/adr/0012): FulfillmentRecord stops being polymorphic.
-- The Phase 0 (orderType, orderId) TEXT pair carried no referential integrity
-- at all, which is what ARCHITECTURE.md §6.1.3 flagged. Both are replaced by
-- real FKs with a CHECK requiring exactly one — the same discriminator
-- mechanism PaymentIntent got in issue #85 — and §4.7's TODO facility column
-- becomes a real FK to FacilityProfile.

-- No code path in backend/src ever wrote this table, and an unvalidated
-- (orderType, orderId) pair cannot be reinterpreted as a typed reference,
-- so abort instead of guessing (same posture as #9's placeholder guard).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "FulfillmentRecord") THEN
    RAISE EXCEPTION 'Issue #13 migration requires placeholder FulfillmentRecord rows to be reviewed before migration';
  END IF;
END $$;

ALTER TABLE "FulfillmentRecord" DROP COLUMN "orderType", DROP COLUMN "orderId";
ALTER TABLE "FulfillmentRecord"
  ADD COLUMN "prescriptionId" TEXT,
  ADD COLUMN "labOrderId" TEXT,
  ADD COLUMN "facilityId" TEXT NOT NULL;

-- One fulfillment row per order, ever: Postgres keeps NULLs in a unique
-- index, so each column allows at most one non-null occurrence.
CREATE UNIQUE INDEX "FulfillmentRecord_prescriptionId_key" ON "FulfillmentRecord"("prescriptionId");
CREATE UNIQUE INDEX "FulfillmentRecord_labOrderId_key" ON "FulfillmentRecord"("labOrderId");
-- The facility's assigned-orders queue (§5.3) filters its own rows by status.
CREATE INDEX "FulfillmentRecord_facilityId_status_idx" ON "FulfillmentRecord"("facilityId", "status");

ALTER TABLE "FulfillmentRecord" ADD CONSTRAINT "FulfillmentRecord_exactly_one_order_check"
  CHECK (("prescriptionId" IS NOT NULL) <> ("labOrderId" IS NOT NULL));
-- RESTRICT everywhere: neither deleting an order nor deleting a facility
-- account may erase the fulfillment trail (docs/adr/0010's retention rule).
ALTER TABLE "FulfillmentRecord" ADD CONSTRAINT "FulfillmentRecord_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FulfillmentRecord" ADD CONSTRAINT "FulfillmentRecord_labOrderId_fkey" FOREIGN KEY ("labOrderId") REFERENCES "LabOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FulfillmentRecord" ADD CONSTRAINT "FulfillmentRecord_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "FacilityProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
