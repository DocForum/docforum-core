Phase 5: structured rejection reasons on fulfillment records and unfulfilled items
([issue #322](https://github.com/DocForum/docforum-core/issues/322)).
`FulfillmentRecord.rejectionReason` (enum) and optional `rejectionNote` (max 500 chars)
are now required when a facility rejects a whole record; `FulfillmentItem.unfulfilledReason`
and optional `unfulfilledNote` are required when marking an item unfulfilled.
Both are stored atomically with the status transition. `getOrderFulfillmentSummary`
now surfaces rejection and unfulfilled reasons in the patient-facing summary.
