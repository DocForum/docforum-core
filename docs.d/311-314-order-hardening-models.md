---
file: ARCHITECTURE.md
section: 4.5 Prescriptions (versioned, append-only)
---
**`PrescriptionItem.quantity Int?` / `unit String?` (issue #312).** How many
units the prescriber ordered and the dispense unit (e.g. `21` `tablets`).
Required by the API for every newly issued item; nullable only so rows issued
before the migration stay as they were (append-only: never backfilled). A
correction carries its own quantities. `getItemsForFulfillment` returns it as
`FulfillmentItem.quantityOrdered`, and dispensing more than that is a `400`.

---
file: ARCHITECTURE.md
section: 4.6 Lab orders (versioned, append-only)
---
**`LabOrder.expiresAt` is set at issuance (issue #313)** from
`LAB_ORDER_ROUTINE_TTL_DAYS` (default 30) or `LAB_ORDER_URGENT_TTL_DAYS`
(default 7). The hourly sweep in `jobs/lab-order-expiry.ts` expires unfulfilled
orders through `labOrdersService.expireLabOrder` (conditional update, outbox
`order.expired`, `lab_order.expired` AuditEvent in one transaction).

---
file: ARCHITECTURE.md
section: 4.7 Fulfillment (facility-side)
---
**`OrderDisputeResolution.outcome` is the `DisputeOutcome` enum (issue #311):**
`upheld | rejected | refunded`, plus `unspecified`, which only legacy rows
carry: the migration maps existing free text case-insensitively
(`uphold`/`accepted`/`approved` → `upheld`, `reject`/`denied`/`dismissed` →
`rejected`, `refund` → `refunded`), turns anything else (such as `resolved`)
into `unspecified` and appends the original text to `resolutionNotes`. The API
never accepts `unspecified` for a new resolution. A dispute is resolved once:
the `pending → resolved` update is conditional and a second resolve is `409`.

---
file: docs/api/README.md
section: Orders (`/orders`) — `backend/src/modules/orders`
---
### Order detail reads and dispute administration (issues #311, #314)

| Endpoint | Auth | Body | Notes |
|---|---|---|---|
| `GET /prescriptions/:id` | prescribing doctor, patient or active guardian, the facility it was sent to or one holding a fulfillment record for it, admin | — | Issue #314. The prescription with its items (incl. `quantity`/`unit`), `status`, `supersedesPrescriptionId`, `correctedByPrescriptionId` (the correction, if superseded) and `paymentIntentStatus`. `amountStroops` is a string. Anyone else, or an unknown id: `404`. Each read writes an AccessLog row. |
| `GET /lab-orders/:id` | ordering doctor, patient or active guardian, the facility it was sent to or one holding a fulfillment record for it, admin | — | Issue #314. Same shape for a lab order (`supersedesLabOrderId`, `correctedByLabOrderId`, `paymentIntentStatus`, `expiresAt`). `notes` are decrypted for the ordering doctor and admins only and are `null` for everyone else. `404` otherwise; AccessLog row per read. |
| `POST /admin/orders/disputes/:id/resolve` | admin | `{ resolutionNotes, outcome: 'upheld'\|'rejected'\|'refunded' }` | Issue #311. Only a `pending` dispute can be resolved: a second resolve is `409`, an unknown id `404`, a bad body `400`. |
| `GET /admin/orders/disputes` | admin | — | Issue #311. `?status=pending\|resolved` (anything else `400`), `?limit=` (1–100, default 25), `?cursor=`; answers `{ items, nextCursor }`, newest first. |
