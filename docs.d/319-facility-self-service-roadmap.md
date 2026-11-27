---
file: ROADMAP.md
section: Phase 5 — Facilities & fulfillment
---
- [x] **Facility self-service profile read and update (GET/PATCH /facilities/me).** Tracked as [issue #319](https://github.com/DocForum/docforum-core/issues/319) — **Done**. `ETag` on read, `If-Match` on update (`428`/`412`), coordinates validated together with the `near` bounds, `type` admin-only, `facility.profile_updated` audit event. Integration-tested for concurrency and validation errors.
