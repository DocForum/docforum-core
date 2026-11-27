---
file: ROADMAP.md
section: Phase 8 — Hardening (safety, audit, security)
---
- [x] **Zod request validation for legacy order controllers.** Tracked as [issue #317](https://github.com/DocForum/docforum-core/issues/317) — **Done**. Pharmacy/lab order create and fulfill (new `lab-orders/validation.ts`) and the admin dispute list/resolve parse their input with Zod; the services' duplicated manual checks are removed. Unit tests cover every schema.
