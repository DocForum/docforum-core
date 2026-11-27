---
file: ROADMAP.md
section: Phase 8 — Hardening (safety, audit, security)
---
- [x] **ADR 0019: retire the legacy `Order`/`FulfillmentProof`/`OrderDispute` tables.** Tracked as [issue #315](https://github.com/DocForum/docforum-core/issues/315) — **Done** (ADR). `docs/adr/0019-retire-legacy-order-table.md` inventories every route, job and table on the legacy model and plans the move to `Prescription`/`LabOrder` + `FulfillmentRecord`: Phase A (shipped with #316), Phase B (confirmation and disputes on `FulfillmentRecord`), Phase C (data migration and table drop), plus the follow-up issues.
