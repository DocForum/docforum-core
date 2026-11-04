Phase 5 — facility fulfillment queue
([issue #15](https://github.com/DocForum/docforum-core/issues/15)).

This is the "facility side" of the order lifecycle ARCHITECTURE.md §5.3
describes: every order can be tracked through a `FulfillmentRecord` owned
by the facility that fulfills it.

What changed:

* **Facility queue view:** `GET /facilities/me/queue`
  (`facilitiesController.listFacilityQueue`) returns the signed-in
  facility owner's records, cursor-paginated newest first (by `updatedAt`,
  tie-broken by `id`), with an optional `status` filter. The facility
  profile is resolved from the authenticated user, so there is no
  client-supplied id and no IDOR surface — the same scoping "my facility"
  rule pricing uses.

  The query parameters are validated with `facilityQueueQuerySchema`:
  * `status` is optional and accepts `pending`, `in_progress`,
    `partially_fulfilled`, `fulfilled`, `rejected` (issue #73 split
    orders produce `partially_fulfilled` records).
  * `limit` is capped at 100 with a default of 20; invalid values return
    HTTP 400.
  * `cursor` is an opaque string (the last item's id).

* **`orderKind` / `orderId` mapping for split orders (#73):** the queue
  query filters by `FulfillmentRecord.facilityId` and resolves
  `orderKind: 'prescription'` vs `'lab_order'` from the FK discriminator
  (`prescriptionId` / `labOrderId`), so split orders routed to a second
  pharmacy facility appear correctly in that facility's queue.

* **Integration test** `tests/integration/fulfillment-queue-and-transitions.test.mts`
  covers: queue view returns facility's own records; cursor pagination
  returns correct ordering across pages; status filter including
  `partially_fulfilled`; invalid `status`/`limit`/`cursor` return 400;
  cross-facility isolation rejects foreign facility access (403);
  unauthenticated requests return 401.

ADR note (deferred, per #13): status transitions are handled in
`pharmacy-orders` (PATCH `/fulfillments/:id` for in_progress/rejected,
PATCH `/fulfillments/:id/items/:itemId` for dispensing), so the fulfillment
queue endpoint is read-only for the facility owner.