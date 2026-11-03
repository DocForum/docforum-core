Phase 5 — the facility fulfillment queue and status transitions
([issue #15](https://github.com/DocForum/docforum-core/issues/15)).

This is the "facility side" of the order lifecycle ARCHITECTURE.md §5.3
describes: every order is born with a `FulfillmentRecord` in the
`pending` state, and the facility that the order was issued to is the
only actor that can move it.

What changed:

* **Facility queue view:** `GET /facilities/me/queue`
  (`facilitiesController.listFacilityQueue`) returns the signed-in
  facility owner's records, cursor-paginated by `id` descending (using
  Prisma cursor pagination with `id: { lt: cursor }` and `skip: 1`), with an
  optional `status` filter. The facility profile is resolved from the
  authenticated user, so there is no client-supplied id and no IDOR
  surface — the same scoping "my facility" rule pricing uses.

  The query parameters are validated with `facilityQueueQuerySchema`:
  * `status` is optional and accepts `pending`, `in_progress`,
    `partially_fulfilled`, `fulfilled`, `rejected` (issue #73 split
    orders produce `partially_fulfilled` records).
  * `limit` is capped at 100 with a default of 20; invalid values return
    HTTP 400.
  * `cursor` is an opaque string (the last item's id); invalid cursors
    are silently ignored.

* **`orderKind` / `orderId` mapping for split orders (#73):** the queue
  query filters by `FulfillmentRecord.facilityId` and resolves
  `orderKind: 'prescription'` vs `'lab_order'` from the FK discriminator
  (`prescriptionId` / `labOrderId`), so split orders routed to a second
  pharmacy facility appear correctly in that facility's queue.

* **Integration test** `tests/integration/fulfillment-queue-and-transitions.test.mts`
  covers: issuance creates the row; the queue view returns it;
  cross-facility transitions are rejected (both a wrong-facility token
  and a patient token → 403); `fulfilled` propagates to the order row;
  terminal states reject re-transition (409); and `rejected` is terminal.

ADR note (deferred, per #13): re-routing after a `rejected` record needs
a partial unique index and is intentionally left out of scope here — the
single-row-per-order invariant holds, a `rejected` row is not deleted,
and a new order (new prescription/labOrder) is what a facility gets if
an order is truly unfulfillable.