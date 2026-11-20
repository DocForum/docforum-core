Phase 5.5: escrow contract pinning tested ahead of the SDK 0.3.0 upgrade
([issue #32](https://github.com/DocForum/docforum-core/issues/32)).
**The upgrade itself is blocked**: `docforum-escrow` has never published
`sdk-v0.3.0` (the only releases are `sdk-v0.1.0` and `sdk-v0.2.0`), and this
issue depends on that release. Nothing here fabricates the bump. What is
done: release and refund already build the `EscrowClient` from the contract id
recorded on the intent (`requireRecordedContractId`), so intents funded before
a contract rotation still settle against their own contract; a new integration
case in `tests/integration/payments-assets.test.mts` funds an intent, points
it at `ESCROW_LEGACY_CONTRACT_IDS`, and asserts both release and refund use
that legacy id rather than the active one. The roadmap item stays unchecked
until `sdk-v0.3.0` exists.
