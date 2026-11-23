---
file: ROADMAP.md
section: Phase 8 — Hardening (safety, audit, security)
---
- [x] **Zod request validation for legacy order controllers.** Tracked as [issue #317](https://github.com/DocForum/docforum-core/issues/317) — **Done**. `createPharmacyOrder`, `fulfillPharmacyOrder`, `createLabOrder`, `fulfillLabOrder`, `resolveDispute`, and `listDisputes` previously destructured `req.body || {}` with no schema enforcement. Added `createPharmacyOrderSchema`/`fulfillPharmacyOrderSchema` to `pharmacy-orders/validation.ts`; new `lab-orders/validation.ts` with equivalent schemas; `resolveDisputeSchema`/`listDisputesQuerySchema` added to `orders/validation.ts`. All controllers now use `getParam(req, 'id')` instead of raw `req.params.id as string`.
