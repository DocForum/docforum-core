Phase 5 prerequisite: resolved the polymorphic `FulfillmentRecord` design smell
flagged in ARCHITECTURE.md §6.1.3 and §6.3.1
([issue #13](https://github.com/DocForum/docforum-core/issues/13)) with
`docs/adr/0012-fulfillment-record-typed-order-fks.md`. Decision: keep **one**
table, drop the polymorphism — the Phase 0 `(order_type, order_id)` TEXT pair is
replaced by real `prescription_id` / `lab_order_id` FKs (each `UNIQUE`, a
PostgreSQL `CHECK` requires exactly one, the same mechanism `PaymentIntent` got
in issue #85) and `facilityId` becomes a real FK to `FacilityProfile`. All three
are `RESTRICT`, so deleting an order or a facility account cannot erase the
fulfillment trail (ADR 0010). Splitting into `PrescriptionFulfillment` /
`LabOrderFulfillment` was weighed and rejected: it would give ARCHITECTURE.md
§5.3 step 5 two implementations to keep in sync and a facility's assigned-orders
queue a cross-table union.

No endpoints, services or module code changes: the placeholder had no readers,
so this ships as schema + migration + docs. #14 creates the row, #15 owns the
`→ fulfilled` transition (the only path per hard rule 5), #16 attaches
`LabResult` through its existing table. Two things the ADR decides rather than
invents: one fulfillment row per order, ever — re-routing after a `rejected`
fulfillment needs a partial unique index and stays deferred; and `facilityId` is
denormalised from the order at creation, the equality invariant owned by #14's
service, not a DB trigger.
