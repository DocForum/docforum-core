# docforum-escrow

**[github.com/DocForum/docforum-escrow](https://github.com/DocForum/docforum-escrow)** · Apache-2.0

A Soroban (Stellar) escrow contract + TypeScript client SDK, deliberately generic and healthcare-agnostic — it knows nothing about patients, doctors, or referrals. `docforum-core`'s `payments` module imports its SDK as a library dependency; this repo never runs as a network service `docforum-core` calls. See [ADR 0002](/architecture/adr/0002-stellar-escrow-for-fulfillment-payout) (why the split exists) and this repo's own [ADR 0001](/repos/escrow/adr-0001) (why the contract itself stays domain-blind).

Full docs: [README](/repos/escrow/readme), [architecture essentials](/repos/escrow/architecture).

## Contract surface

| Function | Status |
|---|---|
| `create_escrow(payer, payee, token, amount, condition_ref, releaser)` | ✅ Implemented, tested, live on testnet |
| `get_status(escrow_id)` | ✅ Implemented, tested, live on testnet |
| `release(escrow_id, caller)` | ✅ Implemented, tested, live on testnet |
| `refund(escrow_id, caller)` | ✅ Implemented, tested, live on testnet |

Authorization model: `release`/`refund` are restricted to the escrow's `releaser`, a per-escrow address set at `create_escrow` time (not a single contract-level admin) — see [ADR 0002](/repos/escrow/adr-0002).

## Status

**Phase E1 and E2 done, verified live on testnet** — all four functions implemented on `soroban-sdk`, 11 passing local tests, wasm build verified, and a real `release`, `refund`, and unauthorized-caller rejection confirmed on-chain (not just locally). **Phase E3** (TypeScript SDK, `@docforum/escrow-sdk`) is also done — wraps all four functions, distributed as a GitHub Release tarball (npm registry publish is the long-term goal, pending publishing credentials — see [ADR 0003](/repos/escrow/adr-0003)), with 3 tests passing against the live deployment. **Phase E4** (external security review — blocking for any mainnet use) remains open, tracked as an issue on the repo.

Full breakdown: [roadmap](/repos/escrow/roadmap).

## Ecosystem context

This is the one DocForum repo built *on* Stellar from the ground up — a Drips Wave applicant under that program's Stellar-ecosystem criteria. `docforum-core` and `docforum-web` have since gained real (not simulated) Stellar payment integration of their own — a custodial payments module in `docforum-core` and its UI in `docforum-web`, both calling this repo's SDK — see `docforum-core`'s [ADR 0004](/architecture/adr/0004-custodial-payments-v1). All three repos were submitted to the program by the maintainer; this repo remains the one whose *entire* purpose is Stellar-ecosystem work, rather than one module within a larger non-Stellar application.
