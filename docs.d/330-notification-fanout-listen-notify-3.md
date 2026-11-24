---
file: ROADMAP.md
section: Phase 6 — Notifications
---
- [x] Cross-instance real-time fan-out ([issue #330](https://github.com/DocForum/docforum-core/issues/330)): `notify()` publishes ids-only events with `pg_notify`; each instance `LISTEN`s on a dedicated connection, reconnects with backoff (clients get `resync`), and reports the listener state in `/health/ready`. Tested with two app instances on one Postgres.
