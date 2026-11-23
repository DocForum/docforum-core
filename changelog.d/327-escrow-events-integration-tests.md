Phase 5.5: integration tests for `GET /admin/payments/escrow-events`
([issue #327](https://github.com/DocForum/docforum-core/issues/327)).
`backend/tests/integration/escrow-events.test.mts` seeds `EscrowChainEvent` and
`EscrowEventCursor` rows directly and covers admin-only access (401/403 for
every other role), the `state` filter, `detectedAt desc, id desc` ordering,
pagination, query validation, `catchupError` on the affected cursor, and the
unmatched-event flag (`state: unmatched`, `paymentIntentId: null`,
`alertedAt` set) — including one produced by the RPC-free reconcile pass. No
network calls (`fetch` is asserted untouched). The endpoint previously had
only `limit`, so operators could not see past 200 rows: it now takes an
optional opaque `cursor` and returns `nextCursor` (additive; existing callers
unchanged). No schema changes.
