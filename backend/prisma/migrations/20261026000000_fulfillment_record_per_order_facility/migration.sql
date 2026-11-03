-- Amendment to ADR 0012 (docs/adr/0012-fulfillment-record-typed-order-fks.md),
-- driven by issue #73 (item-level partial fulfillment).
--
-- ADR 0012 put a UNIQUE on each order FK — "one fulfillment per order,
-- permanently". Issue #73's split routing requires the patient to route the
-- items one facility could not dispense to a SECOND facility, as "a new
-- fulfillment record for those items only", so one order legitimately owns
-- several records: one per facility that has been asked to dispense part of
-- it.
--
-- The guarantee ADR 0012 was actually buying — no duplicated fulfillment of
-- the same order at the same facility — survives as a composite UNIQUE on
-- (order FK, facility). The per-column UNIQUE is dropped here rather than
-- invented around; a `rejected` record still cannot be swapped for another
-- record at the same facility, and re-routing to a *different* facility is
-- exactly issue #73's documented split flow.

-- DropIndex
DROP INDEX "FulfillmentRecord_prescriptionId_key";

-- DropIndex
DROP INDEX "FulfillmentRecord_labOrderId_key";

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentRecord_prescriptionId_facilityId_key" ON "FulfillmentRecord"("prescriptionId", "facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentRecord_labOrderId_facilityId_key" ON "FulfillmentRecord"("labOrderId", "facilityId");
