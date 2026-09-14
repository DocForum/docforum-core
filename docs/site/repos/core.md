# docforum-core

**[github.com/DocForum/docforum-core](https://github.com/DocForum/docforum-core)** · Apache-2.0

The hub of the org. Owns:
- The product definition — [PRD](/product/prd)
- The full system architecture — [overview](/architecture/overview), [essentials](/architecture/essentials), [ADRs](/architecture/adr/0001-modular-monolith)
- Postgres and every PHI-bearing table
- The `payments` module, the only place `docforum-escrow`'s SDK is imported

## Stack

Node.js + TypeScript, Express 5, PostgreSQL via Prisma. Modular monolith — one deployable, bounded modules under `backend/src/modules/*`, cross-module access only through a module's service interface. See [ADR 0001](/architecture/adr/0001-modular-monolith).

## Status

**Phase 1 (identity, DB, safe booking foundation): built and tested.** Real signup/login/refresh/logout, admin-gated doctor verification, fixed-length slot generation, and — the roadmap's own "single highest-priority correctness item" — a database-level guarantee against double-booking, proven by a self-contained integration test that fires genuinely concurrent booking requests against a real Postgres instance every run.

Full breakdown: [roadmap](/roadmap/core).

## Live preview

Deployed to Render (free tier — see [ADR 0003](/architecture/adr/0003-render-preview-deployment)):
**[docforum-core-api.onrender.com](https://docforum-core-api.onrender.com)** — `GET /health` to check it's up. Cold-starts after 15 minutes idle. Endpoint reference: [API docs](/api/reference).
