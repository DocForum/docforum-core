Phase 5.5: releaser key custody decided (ADR 0016, closes
[issue #25](https://github.com/DocForum/docforum-core/issues/25)). Production
escrows will use a 2-of-4 Stellar multisig releaser (three custodied signer
keys plus an offline master key; medium/high threshold 2), so a single leaked
or lost key can neither drain nor lock open escrows. KMS/HSM is deferred as
a v1 choice, and per-period rotation is rejected as the primary control.
Prerequisites are recorded as follow-ups, not implied as done: the
`docforum-escrow` SDK must collect a second signature, `PaymentIntent` must
persist the releaser public key it was funded under so key rotation cannot
strand old escrows, and settlement needs a two-step approval. Payments stay
behind the feature flag until those land; staging and the preview keep a
single-signer testnet releaser.
