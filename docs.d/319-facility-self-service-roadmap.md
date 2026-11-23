---
file: ROADMAP.md
section: Phase 5 — Facilities & fulfillment
---
- [x] **Facility self-service profile read and update (GET/PATCH /facilities/me).** Tracked as [issue #319](https://github.com/DocForum/docforum-core/issues/319) — **Done**. Facility owners can read their own profile (`GET /facilities/me`, ETag) and update `name`, `address`, `latitude`, `longitude` (`PATCH /facilities/me`, If-Match required). Uses the existing `FacilityProfile.version` column with the `updateManyAndReturn` conditional-update pattern (same as patients/doctors); writes a `facility.profile_updated` audit event. New `facilityUpdateSchema` Zod validator; `updateFacilityProfile` repo function; `getOwnFacilityProfile`/`updateOwnFacilityProfile` service functions.
