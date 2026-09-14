# ADR 0002: Stellar escrow as a consumed library, not a network service; org split into 3 repos

Status: Accepted
Date: 2026-09-09

## Context
DocForum is being split across a 3-repo GitHub organization
(`docforum-core`, `docforum-web`, `docforum-escrow`) partly to make
`docforum-escrow` a credible, independently-evaluable Stellar Wave Program
applicant (see PRD-adjacent conversation history / org rationale — a
healthcare-domain monolith is a weak Stellar Wave fit; a purely
Stellar-native escrow repo is a strong one).

This creates tension with ADR-implicit decision in `ARCHITECTURE.md` §1:
"modular monolith first, not microservices."

## Decision
`docforum-escrow` is published as an installable package
(`@docforum/escrow-sdk`) wrapping the Soroban contract's client calls.
`docforum-core`'s `payments` module **imports this package as a library
dependency** — it does not call `docforum-escrow` as a running network
service. This preserves the "modular monolith" principle for the actual
running application (one deployable backend, one DB, one process boundary)
while still giving Stellar its own independently-evaluable repo.

`docforum-core` owns all relational metadata about payments
(`PaymentIntent`, `WalletLink`) — no PHI ever crosses into
`docforum-escrow`, which has no database and no healthcare domain
knowledge at all.

## Consequences
- `docforum-escrow` must version its SDK carefully (semver) since
  `docforum-core` pins a version rather than always calling "live" code.
- `docforum-core`'s CI needs a step to bump/test against new
  `docforum-escrow` releases — not yet built, tracked in ROADMAP.md.
- `docforum-web` never talks to `docforum-escrow` directly; it only ever
  talks to `docforum-core`'s API, which is the only place wallet/payment
  status is exposed to the frontend.
- **Resolved 2026-09-14:** confirmed against the actual Drips Wave program
  docs (docs.drips.network/wave/). Wave is currently Stellar-ecosystem-only
  (launching January 2026), applied per-repo, and approval runs substantially
  on an "Applicant Metrics" GitHub-activity scorecard (PRs/issues/reviews
  over a rolling 3-year window) plus organizer discretion on ecosystem
  relevance — not a code-review gate. `docforum-core` and `docforum-web`
  have no Stellar code and are not ecosystem-relevant to a Stellar-only
  Wave: **decision is to not apply either of them.** Only `docforum-escrow`
  will be submitted, once it has enough real activity (commits/PRs/issues)
  to be a credible applicant under that scorecard — see its own
  `ROADMAP.md` Phase E1–E4 and the issues tracking that work.
