---
file: ROADMAP.md
section: Phase 8 — Hardening (safety, audit, security)
---
- [x] Admin user directory: `GET /admin/users` with role / active / deactivated / deleted filters, indexed email-prefix search and keyset pagination; account-level fields only, tombstones marked `deleted` with a null email. Tracked as [issue #275](https://github.com/DocForum/docforum-core/issues/275) — **Done.**
- [x] Auth-artifact retention: a batched, configurable prune for expired/consumed `EmailVerificationToken`, `PasswordResetToken` and `AdminInvite` rows, revoked `RefreshSession` rows and stale `Sep10Challenge` rows (`src/jobs/auth-token-prune.ts`). Live tokens and active sessions are never touched. Tracked as [issue #276](https://github.com/DocForum/docforum-core/issues/276) — **Done.**
- [x] Admin invite list/revoke: `GET /admin/invites` and `DELETE /admin/invites/:id` (conditional revoke vs. redeem, audited), so an unredeemed invite can be cancelled. Tracked as [issue #277](https://github.com/DocForum/docforum-core/issues/277) — **Done.**
- [x] Active refresh-session cap: `MAX_ACTIVE_SESSIONS_PER_USER` (default 10), enforced atomically with session creation by evicting the least recently used sessions under a per-user advisory lock. Tracked as [issue #278](https://github.com/DocForum/docforum-core/issues/278) — **Done.**
