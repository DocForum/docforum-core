# docforum-core

**[github.com/DocForum/docforum-core](https://github.com/DocForum/docforum-core)** · Apache-2.0

The hub of the org. Owns:
- The product definition — [PRD](/product/prd)
- The full system architecture — [overview](/architecture/overview), [essentials](/architecture/essentials), [ADRs](/architecture/adr/0001-modular-monolith)
- Postgres and every PHI-bearing table
- The `payments` module — the only place `docforum-escrow`'s SDK is imported, wired up for real (not just scaffolded) as of Phase 5.5

## Stack

Node.js + TypeScript, Express 5, PostgreSQL via Prisma. Modular monolith — one deployable, bounded modules under `backend/src/modules/*`, cross-module access only through a module's service interface. See [ADR 0001](/architecture/adr/0001-modular-monolith).

## Status

**Phase 1 (identity, DB, safe booking foundation): built and tested.** Real signup/login/refresh/logout, admin-gated doctor verification, fixed-length slot generation, and — the roadmap's own "single highest-priority correctness item" — a database-level guarantee against double-booking, proven by a self-contained integration test that fires genuinely concurrent booking requests against a real Postgres instance every run.

**Phase 5.5 (Payments): also built, ahead of Phases 2–5** — a custodial payments module (this repo holds its own Stellar identities rather than patients signing with a wallet; see [ADR 0004](/architecture/adr/0004-custodial-payments-v1)) that really moves funds through `docforum-escrow`'s live testnet contract via its SDK. Verified against the real network, not mocked: fund → release, fund → refund, and reject-when-unlinked, all passing. Payments was deliberately decoupled from the unbuilt phases (opaque order references instead of hard foreign keys) rather than waiting.

**Phase 3 (referrals): the core is built and tested** — a referral's notes are an immutable snapshot taken at creation, acceptance books a real appointment through the same concurrency-safe slot-claim path as a direct booking (no re-intake), cancellations and no-shows cascade back into the referral inside the same transaction, repeat doctors/specialties in a referral chain are flagged for human review with a hard hop limit, one consultation can spawn several referrals atomically, and admins get a stuck-referral queue with audited reassign/cancel. Intake (Phase 2) and orders (Phase 4) are still scoped into issues but not built.

Full breakdown: [roadmap](/roadmap/core).

## Live preview

Deployed to Render (free tier — see [ADR 0003](/architecture/adr/0003-render-preview-deployment)):
**[docforum-core-api.onrender.com](https://docforum-core-api.onrender.com)** — `GET /health` to check it's up. Cold-starts after 15 minutes idle. Endpoint reference: [API docs](/api/reference).
