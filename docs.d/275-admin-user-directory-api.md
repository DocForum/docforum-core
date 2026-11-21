---
file: docs/api/README.md
section: Auth (/auth) — backend/src/modules/auth
---
### Admin account directory (Phase 8, issue #275)

`GET /admin/users` is admin-only and read-only. It exists so support work
("find this account's id") no longer needs database access.

| Method & path | Auth | Query | Notes |
|---|---|---|---|
| `GET /admin/users` | admin | `role` (`patient`\|`doctor`\|`facility`\|`admin`), `state` (`active`\|`deactivated`\|`deleted`), `emailPrefix`, `limit` (1–200, default 50), `cursor` | Newest first, keyset-paged on `(createdAt DESC, id DESC)` like the audit list. Returns `{ items, nextCursor }`. Items are account-level fields only: `id`, `email`, `role`, `locale`, `emailVerifiedAt`, `deactivatedAt`, `deletedAt`, `deleted`, `createdAt`, `updatedAt` — never `passwordHash`, token fields, TOTP secrets or any clinical data. A deleted (tombstoned) account has `deleted: true` and `email: null`; its internal `deleted+<id>@deleted.invalid` placeholder is never returned. Unknown parameters and a malformed cursor are `400`. `emailPrefix` is an indexed prefix match (no wildcard interpretation). |
