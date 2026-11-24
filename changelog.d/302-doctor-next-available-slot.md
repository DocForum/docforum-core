Phase 2: show each doctor's next available slot in search results and add availableBefore filter ([issue #302](https://github.com/DocForum/docforum-core/issues/302)).
`GET /doctors` now returns `nextAvailableAt` per item via a batched availability lookup and supports an optional `availableBefore` query filter while preserving keyset pagination.
