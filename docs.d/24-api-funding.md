---
file: docs/api/README.md
section: Payments (/payments) — backend/src/modules/payments
---

**Funding is idempotent (issue #24).** `POST /payments/intents/:id/fund`
claims the intent `created -> funding` with a conditional database update
before calling the escrow contract, so of N concurrent fund requests exactly
one reaches the chain and the rest get `409` (no escrow is created for them).
A failed chain call returns the intent to `created` so it can be retried; an
intent left in `funding` means a crash between the chain call and the status
write and must be resolved with `npm run reconcile:escrows` (read-only report
first, then `--adopt` or `--abandon`), never by calling fund again. The
admin history filter accepts `status=funding`.
