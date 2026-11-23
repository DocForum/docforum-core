---
file: ARCHITECTURE.md
section: 4.13 Payments (Phase 5.5 — ADR 0004 custodial v1, ADR 0005 non-custodial)
---

**Funding claim (issue #24).** `funding` is a transient status a fund request
sets with ONE conditional UPDATE (`WHERE status = 'created'`) that commits
**before** `create_escrow`; the winner is the only request that reaches the
chain, and every concurrent request gets `409` without a chain call.
`funding_started_at` records when the claim was taken (null outside the
state), so a stuck claim is a row older than
`ESCROW_FUNDING_STALE_AFTER_SECONDS` rather than a guess based on
`updated_at`. A failed chain call moves the row back to `created`
(`payment_intent.funding_failed`) so a retry with the same id works; a crash
between a successful call and the settle write leaves it in `funding`, and
`npm run reconcile:escrows` reports it and resolves it explicitly
(`--adopt` an escrow the event poller observed, or `--abandon` a claim that
never reached the chain). It is never retried automatically — a retry could
create a second escrow.
