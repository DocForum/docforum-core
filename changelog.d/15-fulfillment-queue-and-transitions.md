Phase 5 — the facility fulfillment queue and status transitions
([issue #15](https://github.com/DocForum/docforum-core/issues/15)).

This is the "facility side" of the order lifecycle ARCHITECTURE.md §5.3
describes: every order is born with a `FulfillmentRecord` in the
`pending` state, and the facility that the order was issued to is the
only actor that can move it.

What changed:

* **Order issuance now creates the fulfillment row.** `issuePrescription`
  and `issueLabOrder` (orders services) each write a `FulfillmentRecord`
  with `status: 'pending'` against the issuing transaction, pointing at
  the new order's `prescriptionId` / `labOrderId` and its
  `facilityProfileId`. The `facilityId` is copied from the order (the
  invariant #13 ADR §"facilityId is denormalised from the order at
  creation" says #14 owns, and this is that creation step — no trigger).

* **Facility queue view:** `GET /facilities/me/queue`
  (`facilitiesController.listFacilityQueue`) returns the signed-in
  facility owner's records, cursor-paginated by `updatedAt` descending,
  with an optional `status` filter. The facility profile is resolved
  from the authenticated user, so there is no client-supplied id and no
  IDOR surface — the same scoping "my facility" rule pricing uses.

* **Status transitions:** `PATCH /facilities/me/fulfillments/:fulfillmentId`
  (`facilitiesController.transitionFulfillment`) accepts the documented
  forward transitions:

  | from           | to           |
  |----------------|--------------|
  | `pending`      | `in_progress`, `rejected` |
  | `in_progress`  | `fulfilled`, `rejected`  |
  | `fulfilled`    | — (terminal) |
  | `rejected`     | — (terminal) |

  The service layer, not just the route gate, enforces:

  * **`requireRole('facility')`** on the route (401/403 before a non-facility
    caller reaches anything);
  * **row ownership:** the service looks the record up by id, then 403s if
    the record's `facilityId` is not the requesting facility's profile
    — this is what stops cross-facility transitions even when a facility
    somehow guesses an id;
  * **terminal states:** `fulfilled` and `rejected` are terminal; a
    second transition on a terminal row returns 409.

* **`fulfilled` is reachable only from a facility.** On `→ fulfilled`
  the service updates the underlying `Prescription` / `LabOrder` status
  to `fulfilled` inside the same transaction. This is the *only* path to
  `fulfilled` for Phase 5 orders (ARCHITECTURE.md §5.3 hard rule 5):
  the patient `confirm-receipt` and `dispute` endpoints update the
  legacy `Order.confirmed` / `Order.disputed` flags only, and never set
  the order `status` to `fulfilled` or touch a `FulfillmentRecord`. The
  order-status flip is audited as `prescription.fulfilled` /
  `lab_order.fulfilled` with the `FulfillmentRecord` id in metadata.

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
