# ADR 0019: Retire the Legacy `Order` / `FulfillmentProof` / `OrderDispute` Tables

**Status:** Proposed  
**Date:** 2026-11-23  
**Issue:** [#315](https://github.com/DocForum/docforum-core/issues/315)

## Context

The codebase contains a set of legacy tables (`Order`, `FulfillmentProof`,
`OrderDispute`, `OrderDisputeResolution` in `prisma/schema/orders.prisma`) that
pre-date the item-level fulfillment architecture introduced in Phase 5 (issue
#73) and the typed order FK design from ADR 0012.

Current state of each table:

| Table | Purpose | Phase-5 replacement |
|---|---|---|
| `Order` | One row per legacy pharmacy/lab order (`orderType`), with receipt confirmation (`confirmed`, `confirmationSource`) and a `disputed` flag | `Prescription` / `LabOrder` rows (ADR 0012), with `FulfillmentRecord` + `FulfillmentItem` for item-level tracking (issue #73) |
| `FulfillmentProof` | Reference number, notes and an optional proof file for a fulfilled `Order` | Since issue #316 the file is uploaded to private object storage (`attachmentObjectKey`, `attachmentContentType`, `attachmentByteSize`); the pre-#316 client-supplied value survives, untrusted, as `legacyAttachmentUrl` |
| `OrderDispute` / `OrderDisputeResolution` | Patient dispute + admin resolution | No dedicated replacement yet |

### Inventory (as of this ADR)

| Kind | Where | Uses |
|---|---|---|
| Route | `POST /pharmacy-orders`, `GET /pharmacy-orders/:id`, `POST /pharmacy-orders/:id/fulfill` (`pharmacy-orders`) | `Order`, `FulfillmentProof` |
| Route | `POST /lab-orders`, `GET /lab-orders/:id`, `POST /lab-orders/:id/fulfill` (`lab-orders`, through the `pharmacy-orders` repository) | `Order`, `FulfillmentProof` |
| Route | `PUT` / `GET /fulfillment-proofs/:proofId/attachment` (`pharmacy-orders`, issue #316) | `FulfillmentProof` |
| Route | `POST /orders/:id/confirm-receipt`, `POST /orders/:id/dispute`, `GET /orders/:id` (`orders`) | `Order`, `OrderDispute`, `FulfillmentProof` |
| Route | `GET /admin/orders/disputes`, `POST /admin/orders/disputes/:id/resolve` (`orders`) | `OrderDispute`, `OrderDisputeResolution`, `Order`, `FulfillmentProof` |
| Job | `src/jobs/order-expiry.ts` (unconfirmed-order timeout confirmation, issue #76) | `Order` |
| Export / retention | Patient export (`src/export-sections.ts`) and the orders retention hold (`patientHasOrders`) read only `Prescription` / `LabOrder` today, so legacy `Order` rows are neither exported nor protected by a retention hold | — |

Three problems motivate this ADR:

1. **Two order models.** Clinical orders written by doctors live in
   `Prescription` / `LabOrder` (append-only, payments, item-level
   fulfillment), while receipt confirmation and disputes exist only on the
   generic `Order` rows created by the legacy routes. Contributors can't tell
   which one to build on, and nothing links the two.
2. **Weaker legacy routes.** The legacy create/read routes predate the access
   rules of the newer modules (any signed-in caller can create or read an
   `Order`), and until issue #316 a facility could store any URL as "proof".
3. **No item-level history.** `FulfillmentProof` has one row per order, so
   partial dispensing (issue #73) cannot be represented.

## Decision

Target model: `Prescription` / `LabOrder` + `FulfillmentRecord` are the only
order model. Receipt confirmation and disputes move onto `FulfillmentRecord`,
and the legacy tables are retired in stages:

**Phase A — make the proof column honest (done in issue #316)**  
The client-supplied `FulfillmentProof.attachmentUrl` was renamed to
`legacyAttachmentUrl` (data kept, never written again, never served as a
link), and proof files go to private object storage under a server-generated
key with an access-checked download route.

**Phase B — confirmation and disputes on `FulfillmentRecord`**  
Add confirmation fields and a `FulfillmentDispute` (or reuse `OrderDispute`
with a `fulfillmentRecordId` FK) for the new model, move the confirm/dispute
routes and the order-expiry job over, and stop creating new `Order` rows
(the legacy create routes answer `410 Gone`). The patient and facility UIs in
docforum-web switch to the new routes first.

**Phase C — migrate and drop**  
Copy each legacy `Order` with its proofs and disputes into the new model
where a matching `Prescription` / `LabOrder` exists, and into an archived,
read-only export section otherwise, so no row is dropped unaccounted for.
Verify row counts against a production copy, add the archived rows to the
patient export and retention hold, then drop the four legacy tables.

## Consequences

- **Phase A** is shipped with #316 and is independent of the rest.
- **Phase B** removes the dual model for new data at the cost of a
  coordinated frontend change.
- **Phase C** removes the schema debt but is the highest-risk step and must be
  gated on production row-count verification.

## Follow-up issues implied

1. Access checks on the legacy read routes (`GET /orders/:id`,
   `GET /pharmacy-orders/:id`, `GET /lab-orders/:id`) and role checks on the
   legacy create routes, until Phase B retires them.
2. Phase B: confirmation and disputes on `FulfillmentRecord`, plus moving the
   order-expiry job.
3. Phase C: the data migration, export/retention coverage of archived rows,
   and the table drop.

## Alternatives considered

**Keep the legacy tables as a read-compatible view.** A SQL view over
`Prescription`/`LabOrder` would let old API consumers keep working during the
migration, but adds permanent maintenance surface and prevents the column
rename from completing. Rejected.

**Merge `FulfillmentProof` into `FulfillmentRecord`.** Would unify the two
proof representations but requires a data migration and a breaking API change
in a single step. Deferred to Phase B/C.
