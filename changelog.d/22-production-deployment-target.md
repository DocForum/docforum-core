Phase 9: production deployment target decided (ADR 0015, closes
[issue #22](https://github.com/DocForum/docforum-core/issues/22)).
The target is Render on the paid tier — one Pro workspace, a Blueprint-defined
staging and production web service, and a paid Render Postgres per
environment. That removes the free-tier 30-day database expiry (the
2026-12-04 deadline is the last one) and gives 7-day PITR; ADR 0007's
encrypted `pg_dump` + weekly restore drill now run against a real
environment. Secrets live in per-environment Render environment groups with
the team password manager as the source of record. ADR 0003's free-tier
preview is unchanged and stays preview-only. `ARCHITECTURE.md` §8 and §7 now
point at the decision instead of listing it as open, and the Phase 9
staging/production items are unblocked (not yet provisioned).
