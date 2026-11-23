---
file: ROADMAP.md
section: Phase 5 — Facilities & fulfillment
---
- [x] **Fulfillment-proof attachments stored in private object storage.** Tracked as [issue #316](https://github.com/DocForum/docforum-core/issues/316) — **Done**. `fulfillPharmacyOrder` and `fulfillLabOrder` now upload attachment data via `getObjectStorage().putObject(...)` (S3-compatible, server-side encrypted) instead of the legacy `storageService` stub that invented `storage://…` placeholder URLs. The storage key (not a URL) is stored in `FulfillmentProof.attachmentUrl`; `utils/storage.ts` is marked `@deprecated`. See ADR 0014 (same object-storage decision as lab results).
