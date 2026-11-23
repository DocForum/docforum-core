Phase 5.5: facility payout-wallet changes are audited and take effect after a cool-down
([issue #328](https://github.com/DocForum/docforum-core/issues/328)).
Every wallet link now writes an `AuditEvent` (`entity_type: 'WalletLink'`,
`wallet_link.linked` / `wallet_link.changed`, previous and new address for
facilities) in the same transaction as the change. New column
`WalletLink.effectiveAt` (migration `20261123163830_wallet_link_effective_at`,
backfilled from `createdAt`): a facility re-link only becomes the escrow payee
after `WALLET_LINK_COOLDOWN_HOURS` (default 24). Until then funding and
prepare keep paying the previously effective address. The first-ever link for
a facility, and every patient link, are immediate. Re-linking inside the
window cancels the pending link. Escrows already funded stay bound to their
recorded payee. As defence in depth, both release paths refuse a payee that
is known only as a not-yet-effective link (`409 WALLET_LINK_COOLDOWN`). The
outbox retries a held automatic release and then dead-letters it, and the funds
stay in escrow. New admin endpoint
`GET /admin/payments/wallet-links/pending`.
