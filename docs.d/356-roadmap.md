---
file: ROADMAP.md
section: Phase 5.5 — Payments (consumer side)
---
- [x] Operator runbook for the escrow event alerts and RPC retention gaps this phase produces (issue #356): `docs/runbooks/escrow-event-alerts.md` covers reading `GET /admin/payments/escrow-events` (items, cursors, `catchupError`), triaging an `unmatched` release or refund through the intent, audit trail, dead letters and `npm run reconcile:escrows`, when to pause `payments.wallet_funding` and what pausing does not stop, and how to recover a contract whose cursor stalled behind the RPC's retained history. Every step cites the code path it relies on, and the runbook ends with the operator controls that do not exist yet so nobody hunts for them. Linked from `ARCHITECTURE_ESSENTIALS.md`'s escrow monitoring section and from the docs site, which now syncs `docs/runbooks/`.
