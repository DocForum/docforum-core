---
file: ROADMAP.md
section: Phase 9 — Deploy & CI
---
- [x] Query budget tests catch N+1 queries on list endpoints
  ([issue #122](https://github.com/DocForum/docforum-core/issues/122)): a
  per-request Prisma operation counter (`X-Query-Count-Id` +
  `AsyncLocalStorage`, inert outside tests) and
  `backend/tests/integration/query-budgets.test.mts`, which asserts a constant
  budget at 1 and 50 rows for every growing list endpoint — appointments,
  consultations, referrals, orders, notifications, doctor search and the
  pharmacy queue. It found and fixed a real N+1: both referral lists wrote one
  `AccessLog` row per referral (53 queries at 50 rows) and now write one
  batched INSERT. The convention for new list endpoints is in `AGENTS.md`.
