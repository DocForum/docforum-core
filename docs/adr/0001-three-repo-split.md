# ADR 0001: Split into three repos (docforum-core, docforum-web, docforum-escrow)

Status: Accepted
Date: 2026-09-14

## Context

`ARCHITECTURE.md` §1 and §6.3.3 (as of v0.1) call for a single modular-monolith
repo and explicitly flag "separate repos, separate CI, internal API
versioning" as overengineering for v1.

The `DocForum` GitHub org and three repos already exist and are in active
use: `docforum-core`, `docforum-web`, `docforum-escrow`. `docforum-escrow`
implements payment escrow (create/release/refund) as a Rust Soroban smart
contract with a TypeScript client SDK — a different language/runtime than
the rest of the stack, with no PHI and no healthcare domain logic, deployed
to a blockchain target rather than the app's own infra.

## Decision

Adopt a 3-repo split at the org level:
- `docforum-core` — backend modular monolith (unchanged internally: still one
  deployable, module boundaries enforced via service interfaces only, per
  §3).
- `docforum-web` — React/Vite frontend, talks only to `docforum-core`'s API.
- `docforum-escrow` — Rust Soroban escrow contract + TS SDK. Generic,
  reusable, no PHI. `docforum-core`'s `payments` module is the only consumer.

This overrides the "no separate repos" guardrail in §6.3.3, but only at the
repo level for escrow. It does **not** reverse the modular-monolith decision
for the healthcare-domain backend modules (auth, doctors, appointments,
referrals, orders, facilities, notifications, etc.) — those stay one
deployable inside `docforum-core`.

## Consequences

- CI must be set up per-repo (three pipelines, not one) — tracked in
  ROADMAP.md Phase 9.
- `docforum-core`'s `payments` module depends on `docforum-escrow`'s
  published SDK; version pinning/release process for that SDK is not yet
  decided (open item — track before Phase 4/5 payment work starts).
- Escrow's smart-contract deploy target (which Soroban/Stellar network,
  key management) is a separate infra decision, not covered by this ADR.
