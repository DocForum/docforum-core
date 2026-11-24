Phase 5.5: operator runbook for escrow event alerts and RPC retention gaps
([issue #356](https://github.com/DocForum/docforum-core/issues/356)).
`docs/runbooks/escrow-event-alerts.md` covers reading
`GET /admin/payments/escrow-events`, triaging an `unmatched` release or refund
(intent lookup, audit trail, dead letters, `npm run reconcile:escrows`), pausing
`payments.wallet_funding`, and recovering a stalled contract by setting a
reviewed, strictly later `ESCROW_CONTRACTS` start ledger. Every step was written
against the current code paths and cites the file it depends on; the runbook ends
with the controls that do not exist yet, so an operator stops looking for them.
It is linked from the `ARCHITECTURE_ESSENTIALS.md` escrow monitoring section
(`docs.d/356-escrow-event-alerts-runbook.md`) and from the docs site, which now
syncs `docs/runbooks/` like the other doc trees. No code, schema or endpoint
changed.
