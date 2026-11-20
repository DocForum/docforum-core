---
file: docs/api/README.md
section: Payments (`/payments`) — `backend/src/modules/payments`
---

Automatic settlement (issues #83/#84): when an order reaches the
facility-derived `fulfilled` state, or is rejected with nothing dispensed, or
a lab order expires unfulfilled, the order module publishes
`order.fulfilled` / `order.rejected` / `order.expired` **in the transaction
that performs the transition**. The transactional-outbox worker then settles
the intent (SDK `release` or `refund`) with bounded retries and backoff, and
writes `escrowed -> released|refunded` with an audit event
(`settlementSource: automatic`). Delivery is at least once; the conditional
intent update makes a duplicate delivery a no-op, and a release/refund race
commits locally at most once. An SDK `NotFunded` response is terminal: the
intent becomes `failed` with a `payment_intent.settlement_not_funded` audit
row, for operator reconciliation, rather than retrying forever. Refund
completion also creates an in-app `payment_refunded` notification for the
patient. `POST /payments/intents/:id/{release,refund}` remains an audited
admin override. No new endpoint is introduced by this path.
