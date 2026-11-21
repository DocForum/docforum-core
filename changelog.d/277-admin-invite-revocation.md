Phase 8: list and revoke admin invites (issue #277). `GET /admin/invites`
returns pending/redeemed/expired/revoked invites without token hashes;
`DELETE /admin/invites/:id` marks an unredeemed invite revoked with one
conditional UPDATE and writes an `admin_invite.revoked` audit event in the
same transaction. Revoke and redeem race on the same condition, so exactly
one wins: a revoked invite can't be redeemed, and revoking a redeemed invite
returns 409. Migration adds `AdminInvite.revokedAt`; revoked rows are later
removed by the #276 prune.
