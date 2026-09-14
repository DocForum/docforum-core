# docforum-core

Eliminating in-hospital patient waiting time: search a doctor, book, get referred to the right specialist with your context intact, get a prescription/lab order, and get it fulfilled at a qualified facility — all in one continuous thread.

This is the **hub repo** of the `DocForum` GitHub organization. It owns the product (PRD), the full system architecture, and the master roadmap. Sibling repos:
- [`docforum-web`](../docforum-web) — frontend, talks only to this repo's API.
- [`docforum-escrow`](../docforum-escrow) — Soroban smart contract + `@docforum/escrow-sdk`, imported here as a library (never called as a network service — see `docs/adr/0002-stellar-escrow-for-fulfillment-payout.md`).

**Status:** scaffolded, pre-implementation. See `ROADMAP.md` for current phase.

## Start here
1. `PRD.md` — what we're building and for whom.
2. `ARCHITECTURE_ESSENTIALS.md` — fast-reference architecture rules.
3. `ARCHITECTURE.md` — full architecture, data models, tech stack, hard questions.
4. `ROADMAP.md` — phased plan and current status. **Updated on every contribution.**
5. `AGENTS.md` / `CLAUDE.md` — rules for coding agents working in this repo.

## Repo layout
```
backend/    Node.js/TypeScript modular monolith (see ARCHITECTURE.md §3)
frontend/   React/TypeScript client
docs/       ADRs and API docs
infra/      local/deploy infra (Docker, etc.)
scripts/    dev/one-off scripts
```
