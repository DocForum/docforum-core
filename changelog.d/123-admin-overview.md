Phase 8: admin operations overview
([issue #123](https://github.com/DocForum/docforum-core/issues/123)).
`GET /admin/overview` (admin-only) returns the count and oldest-item age for
each queue listed in `src/admin-overview-sections.ts`, with a drill-down path.
Each section comes from its owning module's service. A failing section is
reported as `unavailable` and does not fail the response. The result is cached
for 60 seconds. Only the doctor-verification queue is listed so far. Payments
in intermediate states, failed jobs, stale referrals and unrouted orders still
need their own sections.
