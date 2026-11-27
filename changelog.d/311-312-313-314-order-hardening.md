Issues #311–#314: order module hardening.

**#311** — Harden dispute resolution: `DisputeOutcome` enum (`upheld | rejected |
refunded`, plus `unspecified` for legacy rows only) replaces the free-text
`outcome` column. The migration maps existing values with an explicit
case-insensitive `CASE` and keeps any unmapped original text in
`resolutionNotes`; `resolveDispute` now uses a
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
new endpoint and `GET /lab-orders/:id` now enforces the same rule (it previously
returned any order to any signed-in user): the issuing doctor, the patient or an
active guardian, the facility the order was sent to or one holding a fulfillment
record on it, and admins; 404 otherwise. The rule lives once, in
`pharmacyOrdersService.canViewOrder`, and goes through the doctors, patients and
facilities services (no cross-module table access). Both reads return the items
or notes, status, supersession links both ways (`supersedes…Id`,
`correctedBy…Id`) and `paymentIntentStatus`; lab notes are decrypted only for
the ordering doctor and admins. Each read writes an AccessLog row; both routes
are behind `apiRateLimit`.

Integration tests in `order-detail-reads.test.mts` (port 5497) cover required
quantities, over-dispensing (400) and exact dispensing, routine/urgent
`expiresAt`, the audited expiry (fulfilled orders never expire) and the
per-role reads with their AccessLog rows.
