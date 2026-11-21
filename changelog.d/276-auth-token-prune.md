Phase 8: batched retention prune for auth artifacts (issue #276). A new
`src/jobs/auth-token-prune.ts` deletes expired/consumed
`EmailVerificationToken`, `PasswordResetToken` and `AdminInvite` rows,
revoked `RefreshSession` rows and stale `Sep10Challenge` rows once they are
past `AUTH_TOKEN_PRUNE_GRACE_HOURS`. Each table drains in
`AUTH_TOKEN_PRUNE_BATCH_SIZE`-row `DELETE ... LIMIT` statements, up to
`AUTH_TOKEN_PRUNE_MAX_BATCHES_PER_RUN` per tick. Every delete is conditional
on expiry/consumption/revocation, so live tokens and active sessions are
never removed (integration-tested). Logs counts only.
