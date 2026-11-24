---
file: ARCHITECTURE.md
section: 6.2 What edge cases are we missing (architecture-level)?
---
- **Added (issue #328):** the payout-wallet cool-down protects funds only if someone notices a hostile change inside the window. Today the only signals are the `wallet_link.changed` audit row and `GET /admin/payments/wallet-links/pending`. The facility gets no out-of-band (email) alert, because no email provider is wired yet (issue #17/#95), and there is no "cancel this pending change" action for the facility or an admin. A re-link inside the window does cancel the pending link, but an attacker holding the account can do that too. Revisit when the email adapter lands: send the facility an alert on every `wallet_link.changed`, and consider an admin cancel endpoint.
