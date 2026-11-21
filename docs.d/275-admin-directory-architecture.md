---
file: ARCHITECTURE.md
section: 4.1 User / Role model
---
**Phase 8, issue #275 — admin account directory.** `GET /admin/users` reads
`User` directly through the users module's service/repository; it adds no
model. Its email-prefix search is backed by
`User_email_prefix_idx` (GIN, `email gin_trgm_ops`), because the existing
unique btree on `email` only serves a prefix range under a C collation. The
response is an explicit account-level allowlist (`id`, `email`, `role`,
`locale`, `emailVerifiedAt`, `deactivatedAt`, `deletedAt`, `createdAt`,
`updatedAt`); credentials, token fields, TOTP secrets and every clinical
relation are not selectable. Tombstoned accounts (#41) are returned as
`deleted: true` with `email: null` rather than their
`deleted+<id>@deleted.invalid` placeholder.
