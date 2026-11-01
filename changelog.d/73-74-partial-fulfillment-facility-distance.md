Phase 5: landed issues #73 (partial fulfillment, item-level dispensing for
multi-item prescriptions) and #74 (facility location + distance-sorted
eligible-facility query) together
([issue #73](https://github.com/DocForum/docforum-core/issues/73),
[issue #74](https://github.com/DocForum/docforum-core/issues/74)).

New `FulfillmentItem` model + `partially_fulfilled` order/record statuses,
`FacilityProfile` location fields + composite `(latitude, longitude)` index,
`/pharmacy-orders` fulfillment routes and the `GET /facilities/eligible`
`near`/`radiusKm`/`limit`/`capabilityType` params (bounding box + haversine,
no PostGIS — justification and the never-store-the-patient's-point rule are
in ARCHITECTURE.md §5.4), a dev seed of fictional facility coordinates
(`npx prisma db seed`), and two new integration test files
(`fulfillment.test.mts`, `facility-distance.test.mts`). Payment-release rule
decided and documented in ARCHITECTURE.md §5.3: no release until the whole
order derives `fulfilled`; proration stays an open question in §6.2.

Two things the merge with `main` forced, worth knowing before you touch this
area:

- Both records now hang off ADR 0012's typed order FKs rather than the old
  polymorphic `(orderType, orderId)` pair, and ADR 0012's "one record per
  order" UNIQUE became one record per **(order, facility)** — split routing
  needs a record at each facility. See the ADR's 2026-10-26 amendment and
  migration `20261026000000_fulfillment_record_per_order_facility`.
- The Phase 5 migration no longer adds `PrescriptionItem.prescriptionId` or
  `FulfillmentRecord.facilityId`: main's `20261020000000_order_payment_intents`
  and `20261022090000_fulfillment_record_typed_order_fks` own those columns,
  and a second definition made `prisma migrate deploy` fail (42701) in every
  integration test.
