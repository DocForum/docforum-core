Phase 5.5: multi-asset payment intents and the patient-signed prepare half
of ADR 0005 ([issue #79](https://github.com/DocForum/docforum-core/issues/79),
[issue #80](https://github.com/DocForum/docforum-core/issues/80)).
`PaymentIntent.amountStroops` is renamed to the token-agnostic `amount`
(a column rename in the migration, so existing values are preserved), and
each intent now records an allowlisted `assetCode` + `tokenContractId`
(native XLM + USDC on testnet, configured per environment via
`PAYMENT_ASSETS`). Funding and prepare check the payee's trustline before
any SDK call, and facility totals are grouped per asset rather than summed
across them. `POST /payments/intents/:id/prepare` builds and simulates the
patient-as-payer `create_escrow`, stores the unsigned XDR/hash and moves the
intent `created -> awaiting_signature`; an interval job expires stale
prepared transactions back to `created`. The real SDK call still returns
`503 ESCROW_SDK_PREPARE_UNSUPPORTED` until `@docforum/escrow-sdk` 0.3.0
([issue #32](https://github.com/DocForum/docforum-core/issues/32)) ships;
submit/fee-bump is not part of #80.
