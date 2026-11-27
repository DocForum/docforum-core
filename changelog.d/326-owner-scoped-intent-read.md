Phase 5.5: owner-scoped read of a single payment intent
([issue #326](https://github.com/DocForum/docforum-core/issues/326)).
`GET /payments/intents/:id` now allows the payer patient and payee facility to
read their own intent, returning the same shape as their history rows plus
on-chain references (escrowId, stellarTxHash, sorobanContractId). Admin-only
prepare fields (preparedTxHash, preparedExpiryLedger, preparedExpiresAt) are
hidden from owners. All other callers receive 404.
