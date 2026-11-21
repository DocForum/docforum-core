---
file: docs/api/README.md
section: Availability (/availability) — backend/src/modules/availability
---

- `GET /availability/doctors/:doctorProfileId/slots`: supports optional `?from=&to=` ISO date-time query parameters (capped to 31 days span, default to next 14 days, `from` in the past clamped to `now`). Backed by composite index `(doctorProfileId, status, startTime)`.
