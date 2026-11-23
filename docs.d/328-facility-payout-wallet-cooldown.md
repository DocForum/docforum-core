---
file: ARCHITECTURE.md
after: "# The PAYEE/payout wallet, facility-managed (ADR 0004). Unchanged by #79."
---
  effective_at (timestamp, NOT NULL, default now(); write-once — issue #328)
  # A facility RE-link becomes the escrow payee only at effective_at =
    created_at + WALLET_LINK_COOLDOWN_HOURS (default 24). The first-ever link
    for a facility, and every patient link, are effective immediately. The
    payee at time t is the latest-effective row with effective_at <= t that
    was not cancelled (replaced_at < effective_at = replaced inside its own
    window). Funding/prepare read only that row. Escrows already funded keep
    PaymentIntent.funded_wallet_address. Every link writes an AuditEvent
    (entity_type 'WalletLink', wallet_link.linked|changed, old + new
    facility address) in the same transaction. Pre-#328 rows were backfilled
    with effective_at = created_at.
