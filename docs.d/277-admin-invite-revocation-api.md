---
file: docs/api/README.md
section: Auth (/auth) — backend/src/modules/auth
---
### Admin invite list and revocation (Phase 8, issue #277)

`POST /admin/invites` already issues a single-use invite; these two
admin-only routes make outstanding invites visible and cancellable.

| Method & path | Auth | Query / body | Notes |
|---|---|---|---|
| `GET /admin/invites` | admin | `status` (`pending`\|`redeemed`\|`expired`\|`revoked`, default `pending`), `limit` (1–200, default 50), `cursor` | Newest first, keyset-paged on `(createdAt DESC, id DESC)`: `{ items, nextCursor }`. Item: `{ id, email, status, expiresAt, consumedAt, revokedAt, invitedByUserId, createdAt }`. The token hash is never selected or returned. `status` is derived: `revoked` if `revokedAt`, else `redeemed` if `consumedAt`, else `expired` past `expiresAt`, else `pending`. |
| `DELETE /admin/invites/:id` | admin | — | Revokes an unredeemed invite with one conditional `UPDATE` (`consumedAt IS NULL AND revokedAt IS NULL`). `200 { invite, alreadyRevoked }`; revoking an already-revoked invite is idempotent (`alreadyRevoked: true`, no second audit event). `409` if it was already redeemed. Writes an `admin_invite.revoked` `AuditEvent` in the same transaction (metadata carries ids only — never the invited address). A revoked invite's redemption fails with `400`. |
