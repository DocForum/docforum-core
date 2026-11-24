---
file: ARCHITECTURE.md
section: 4.1 User / Role model
---
**Phase 8, issue #277 — admin invite revocation.**
`AdminInvite.revokedAt` (nullable) marks an invite unusable before it
expires. Redemption (`consumeAdminInviteAndCreateAdmin`) and revocation
(`revokeAdminInviteIfUsable`) are both conditional `updateMany` writes
requiring `consumedAt IS NULL AND revokedAt IS NULL`, so exactly one of
revoke/redeem can win; redeeming a revoked invite is a `400`, revoking a
redeemed one is a `409`. Revocation writes an `admin_invite.revoked`
`AuditEvent` (`entityType: 'AdminInvite'`) in the same transaction. Rows are
retained until the #276 prune removes them a grace period after expiry,
consumption or revocation.
