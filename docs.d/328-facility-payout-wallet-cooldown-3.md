---
file: ROADMAP.md
section: Phase 5.5 — Payments (consumer side)
---
- [x] Audit and cool-down for facility payout-wallet changes ([issue #328](https://github.com/DocForum/docforum-core/issues/328)): every link is audited (old + new address) in its own transaction; a facility re-link becomes the payee only after `WALLET_LINK_COOLDOWN_HOURS` (first-ever link immediate); `GET /admin/payments/wallet-links/pending` lists changes in the window.
