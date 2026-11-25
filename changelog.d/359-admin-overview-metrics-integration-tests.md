Phase 8: integration tests for admin overview and success-metrics endpoints ([issue #359](https://github.com/DocForum/docforum-core/issues/359)).
`backend/tests/integration/admin-overview-and-metrics.test.mts` exercises `GET /admin/overview` and `GET /admin/metrics` against real Postgres:
- Enforces admin authorization gating (401 for anonymous, 403 for patient and doctor roles).
- Validates query parameter checking on `GET /admin/metrics` (RFC3339 offset awareness, interval boundaries, 366-day range cap).
- Tests empty and populated queue state calculations on `GET /admin/overview`, ensuring pending doctor counts and oldest item age are computed accurately without leaking PHI.
- Verifies SQL view aggregation and small-count suppression thresholds (< 5 eligible appointments) for `noShowRate` and `bookingLeadTimeDays` with hand-derived metrics over a pinned clock.
