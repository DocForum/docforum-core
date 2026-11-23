ADR 0015: retire the legacy `Order` / `FulfillmentProof` / `OrderDispute` tables
([issue #315](https://github.com/DocForum/docforum-core/issues/315)).
Documents the three-phase plan (column rename → dual-write removal → table
drop) for consolidating around the Phase-5 `Prescription`/`LabOrder` +
`FulfillmentRecord`/`FulfillmentItem` architecture. No schema or code changes
in this PR — the ADR is the deliverable.
