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
| `Order` | One row per pharmacy/lab order; fulfilled via `FulfillmentProof` | `Prescription` / `LabOrder` rows, with `FulfillmentRecord` + `FulfillmentItem` for item-level tracking |
| `FulfillmentProof` | Simple proof-of-fulfillment attach; `attachmentUrl` stored as a client-supplied URL or `storage://…` placeholder | Phase 7 (issue #316): proof attachments now stored in object storage; key stored in `attachmentUrl` |
| `OrderDispute` / `OrderDisputeResolution` | Dispute + admin resolution | No dedicated replacement yet; kept as-is pending Phase 9 |

Three problems motivate this ADR:

1. **Dual write path.** `createPharmacyOrder` / `createLabOrder` in
   `pharmacy-orders/services` and `lab-orders/services` write both an `Order`
   row (legacy) and the module-native rows, causing two sources of truth for
   the same event.
2. **Stale `attachmentUrl` semantics.** The column was originally a URL; since
   issue #316 it stores an S3 object key. The column name is now misleading.
3. **No item-level history.** `FulfillmentProof` has one row per order, so
   partial dispensing (ADR 0010 / issue #73) cannot be represented.

## Decision

Retire `Order`, `FulfillmentProof`, `OrderDisputeResolution` and
`OrderDispute` in a phased migration:

**Phase A — column rename (non-breaking, no data loss)**  
Rename `FulfillmentProof.attachmentUrl` to `FulfillmentProof.attachmentKey`
in a new migration. Update all callers (currently only the two fulfill
services). ADR 0014's "keys are not URLs" rule applies from that migration
forward.

**Phase B — dual-write removal**  
Remove `createPharmacyOrder` / `createLabOrder` calls that write `Order` rows.
Route all order creation through `Prescription` / `LabOrder`. Prerequisite:
the patient portal must be updated to query the new tables (a frontend task
outside this ADR's scope).

**Phase C — table drop**  
Once no application code or migration references `Order`, `FulfillmentProof`,
`OrderDispute` or `OrderDisputeResolution`, drop them in a final migration.
Run against a production copy first; confirm row counts match the
`Prescription`/`LabOrder` universe before proceeding.

`OrderDispute` / `OrderDisputeResolution` are retained through Phase B: a
Phase 9 dispute redesign will decide their replacement schema.

## Consequences

- **Phase A** is safe and can be merged independently of this ADR's full
  acceptance; it makes the codebase consistent with ADR 0014's invariant.
- **Phase B** eliminates the dual-write path and simplifies the order module's
  mental model at the cost of a coordinated frontend migration.
- **Phase C** removes the schema debt entirely but is the highest-risk step
  and must be gated on production row-count verification.

## Alternatives considered

**Keep the legacy tables as a read-compatible view.** A SQL view over
`Prescription`/`LabOrder` would let old API consumers keep working during the
migration, but adds permanent maintenance surface and prevents the column
rename from completing. Rejected.

**Merge `FulfillmentProof` into `FulfillmentRecord`.** Would unify the two
proof representations but requires a data migration and a breaking API change
in a single step. Deferred to Phase B/C.
