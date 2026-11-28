---
file: ROADMAP.md
section: Phase 2 — Intake, appointments, consultations
---
- [x] Platform and clinic closure calendar that blocks slot generation ([issue #131](https://github.com/DocForum/docforum-core/issues/131)) — `ClosurePeriod` (admin-managed, `scope platform|facility`, inclusive all-day range read in its own IANA `timeZone`), applied on create/update by one conditional DELETE of open slots plus a report of the booked appointments it must not cancel, skipped by slot generation and hidden from the public slot list. Admin CRUD at `/availability/admin/closures` (audited, `If-Match`-guarded PATCH) and a public `GET /availability/closures`. Facility-scoped closures are recorded and listed but block no calendar yet, because `AvailabilitySlot` has no facility (see ARCHITECTURE_ESSENTIALS' known gaps). Integration test: `backend/tests/integration/closure-calendar.test.mts` (7 cases, including a closure created while six bookings are in flight).
