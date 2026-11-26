---
file: ROADMAP.md
section: Phase 8 — Hardening (safety, audit, security)
---
- [x] **ADR 0019: retire the legacy `Order`/`FulfillmentProof`/`OrderDispute` tables.** Tracked as [issue #315](https://github.com/DocForum/docforum-core/issues/315) — **Done** (ADR phase). `docs/adr/0019-retire-legacy-order-table.md` documents the three-phase plan: column rename (`attachmentUrl` → `attachmentKey`, Phase A), dual-write removal (Phase B), table drop (Phase C). No schema or code changes in this PR — the ADR is the deliverable; Phase A begins with issue #316.
