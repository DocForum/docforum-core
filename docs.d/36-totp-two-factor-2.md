---
file: ARCHITECTURE.md
section: 4.1 User / Role model
---
### 4.1.1 TOTP two-factor authentication (Phase 8, issue #36)
```
User (extended)
  totp_secret [ENCRYPTED]   # base32 secret, encrypted with the existing
                            # field-encryption key; null = 2FA not enrolled
  totp_enabled_at           # null until a valid code confirms enrolment
  totp_last_used_step       # last accepted RFC 6238 time step (replay guard)

TwoFactorRecoveryCode
  id, user_id (FK, cascade), code_hash (SHA-256), used_at (nullable),
  created_at
  # single-use: redemption is one conditional UPDATE ... WHERE used_at IS NULL
```
Verification is dependency-free (`node:crypto`, RFC 4226/6238) and accepts a
±1 step window. Replay is prevented server-side: the accepted step is claimed
with a single conditional `updateMany` on `totp_last_used_step`, so two
concurrent requests with the same code cannot both succeed — a client-held
"already used" flag would not survive a replay. Half-authenticated tokens
(`mfa_pending`, and `mfa_enrollment` when `TOTP_REQUIRE_FOR_ADMIN` forces
enrolment for an admin) carry a `typ` claim and are signed with the access
keyring; `verifyAccessToken` rejects any token that has `typ`, so a pending
token can never be used as an access token and an enrolment token is only
accepted by `POST /auth/2fa/setup` and `/enable`. Disabling 2FA requires the
account password, and recovery codes are deleted when it is disabled.
