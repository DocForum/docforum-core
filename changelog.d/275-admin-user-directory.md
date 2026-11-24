Phase 8: read-only admin user directory (issue #275). `GET /admin/users`
filters by role, active/deactivated/deleted state and an indexed email
prefix, with audit-style keyset pagination. The response uses an explicit
account-level allowlist (no credentials, tokens, TOTP secrets or clinical
data), and tombstoned accounts are marked `deleted` with a null email
instead of exposing their internal placeholder address. Migration adds
`User_email_prefix_idx` (trigram GIN) so the prefix search is index-backed
under any collation.
