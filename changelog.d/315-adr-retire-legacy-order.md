ADR 0019 ([issue #315](https://github.com/DocForum/docforum-core/issues/315)):
inventory of every route, job and table that uses the legacy `Order`,
`FulfillmentProof`, `OrderDispute` and `OrderDisputeResolution` tables, and a
staged plan to make `Prescription`/`LabOrder` + `FulfillmentRecord` the only
order model (Phase A shipped with #316; Phase B moves confirmation and
disputes; Phase C migrates the data and drops the tables), with the follow-up
issues it implies.
