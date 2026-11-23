---
file: docs/api/README.md
section: Payments (`/payments`) — `backend/src/modules/payments`
---
Payout-wallet cool-down (issue #328): a facility's `POST /payments/wallet-link`
re-link returns the new link with a future `effectiveAt`. It becomes the
escrow payee only after `WALLET_LINK_COOLDOWN_HOURS` (default 24). Until then,
fund and prepare use the previously effective address. The first-ever
facility link and patient links are immediate. A facility whose only link is
still cooling down gets `409 WALLET_LINK_COOLDOWN` on fund/prepare, and a
release whose recorded payee is only a not-yet-effective link is refused with
the same code. `GET /payments/wallet-link` returns the active link including
`effectiveAt`.

| Method & path | Auth | Query | Notes |
|---|---|---|---|
| `GET /admin/payments/wallet-links/pending` | admin | — | `{ items }` of facility payout changes still inside their cool-down, soonest first: `id`, `facilityId`, `facilityName`, `newStellarPublicKey`, `previousStellarPublicKey`, `linkedAt`, `effectiveAt`. |
