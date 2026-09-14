# docforum-escrow

**[github.com/DocForum/docforum-escrow](https://github.com/DocForum/docforum-escrow)** · Apache-2.0

A Soroban (Stellar) escrow contract + TypeScript client SDK, deliberately generic and healthcare-agnostic — it knows nothing about patients, doctors, or referrals. `docforum-core`'s `payments` module imports its SDK as a library dependency; this repo never runs as a network service `docforum-core` calls. See [ADR 0002](/architecture/adr/0002-stellar-escrow-for-fulfillment-payout) (why the split exists) and this repo's own [ADR 0001](/repos/escrow/adr-0001) (why the contract itself stays domain-blind).

Full docs: [README](/repos/escrow/readme), [architecture essentials](/repos/escrow/architecture).

## Contract surface

| Function | Status |
|---|---|
| `create_escrow(payer, payee, token, amount, condition_ref)` | ✅ Implemented, tested |
| `get_status(escrow_id)` | ✅ Implemented, tested |
| `release(escrow_id, caller)` | 🚧 Not started |
| `refund(escrow_id, caller)` | 🚧 Not started |

## Status

**Phase E1 mostly done** — `create_escrow`/`get_status` implemented on `soroban-sdk`, 4 passing tests, wasm build verified. Testnet deployment is the one remaining manual step. Phases E2 (release/refund), E3 (TS SDK wrapping), and E4 (security review — blocking for any mainnet use) are tracked as open issues on the repo, each scoped as a small independent unit with a stated complexity.

Full breakdown: [roadmap](/repos/escrow/roadmap).

## Ecosystem context

This is the one DocForum repo actually built *on* Stellar — the piece intended to be a credible [Drips Wave](https://docs.drips.network/wave/) applicant once it has enough real GitHub activity (that program's approval runs substantially on a rolling-window activity scorecard, not a one-time code review). `docforum-core` and `docforum-web` won't be submitted — see [ADR 0002](/architecture/adr/0002-stellar-escrow-for-fulfillment-payout)'s resolved note.
