---
file: ROADMAP.md
section: Phase 5 — Facilities & fulfillment
---
- [x] **Fulfillment proof files in private object storage, behind an access check.** Tracked as [issue #316](https://github.com/DocForum/docforum-core/issues/316) — **Done**. The fulfill endpoints no longer accept a client URL; the recording facility uploads the file to `PUT /fulfillment-proofs/:proofId/attachment` (lab-result pattern, ADR 0018: allowlist, magic bytes, size cap, scanner, server-generated key), and `GET` on the same path serves it to the patient/guardian, that facility and admins only. Pre-#316 values are kept as the untrusted `legacyAttachmentUrl`; `utils/storage.ts` is removed.
