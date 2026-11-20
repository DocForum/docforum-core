---
file: docs/api/README.md
section: Auth (`/auth`) — `backend/src/modules/auth`
---
### Two-factor authentication (Phase 8, issue #36)

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /auth/2fa/setup` | access token, or an `mfa_enrollment` token when `TOTP_REQUIRE_FOR_ADMIN` applies to the account | — | Starts enrolment and returns `{ secret, otpauthUri }` (shown once; the secret is stored encrypted). Calling it again before `enable` replaces the pending secret. `409 TWO_FACTOR_ALREADY_ENABLED` once enrolled. |
| `POST /auth/2fa/enable` | access token, or `mfa_enrollment` | `{ code }` | Confirms enrolment with one valid TOTP code and returns `{ recoveryCodes }` — ten single-use codes, visible only here (only their hashes are stored). A wrong/expired code is `400`. |
| `POST /auth/2fa/verify` | `mfa_pending` token in the body (no access token) | `{ mfaToken, code }` | Second login step. `code` is a 6-digit TOTP code **or** a recovery code. Returns the same `{ user, accessToken, csrfToken }` as login and rotates the refresh cookie. Each TOTP time step and each recovery code is accepted **once**; a replay is `401 INVALID_TOTP_CODE`. An expired half-token is `401 INVALID_MFA_TOKEN`. |
| `GET /auth/2fa/status` | access token | — | `{ enabled, unusedRecoveryCodes }`. |
| `POST /auth/2fa/disable` | access token | `{ code }` (current TOTP or recovery code) | Turns 2FA off and deletes the secret and recovery codes. `204`. A wrong code is `401`. |

`POST /auth/login` answers `200 { mfaRequired: true, mfaToken }` instead of an
access token when the account has 2FA enabled. `mfaToken` is short-lived
(`TOTP_MFA_TOKEN_TTL_MINUTES`, default 5) and is rejected by every route
except `POST /auth/2fa/verify`. When `TOTP_REQUIRE_FOR_ADMIN=true` and an
admin without 2FA logs in, the response instead carries
`{ enrollmentRequired: true, enrollmentToken }`, and that token is accepted
only by `2fa/setup` and `2fa/enable`. `TOTP_ISSUER` sets the issuer shown in
the authenticator app (default `DocForum`).
