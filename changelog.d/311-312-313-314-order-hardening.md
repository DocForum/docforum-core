Issues #311–#314: order module hardening.

**#311** — Harden dispute resolution: `DisputeOutcome` enum (`upheld | rejected |
refunded`) replaces the free-text `outcome` column; `resolveDispute` now uses a
conditional `updateMany` (pending → resolved) so a double-resolve returns 409
instead of silently creating a second resolution; `listDisputes` is keyset-paginated;
all inputs are validated with Zod.

**#312** — Prescription item quantity: `PrescriptionItem` gains `quantity Int` and
`unit String` (nullable for pre-migration rows). Both fields are required in
`prescriptionSchema`; `getItemsForFulfillment` now returns real `quantityOrdered` for
the over-dispensing guard.

**#313** — Lab order expiry wired: `expiresAt` is set at issuance from a new
`config.labOrders.{routineTtlDays,urgentTtlDays}` section (env
`LAB_ORDER_ROUTINE_TTL_DAYS` / `LAB_ORDER_URGENT_TTL_DAYS`, defaults 30/7). The
expiry job now delegates per-order transitions to `expireLabOrder` in the
lab-orders service, which records an `AuditEvent` in the same transaction.

**#314** — Prescription and lab order detail reads: `GET /prescriptions/:id` is a
new endpoint with RBAC (prescriber, patient/guardian, facilities with a
FulfillmentRecord on the order, admins — 404 otherwise). `GET /lab-orders/:id`
enforces the same RBAC and decrypts notes only for clinical roles (doctor, admin).
Both endpoints write an AccessLog row fire-and-forget.
