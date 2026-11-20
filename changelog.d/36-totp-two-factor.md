Phase 8: TOTP two-factor authentication
([issue #36](https://github.com/DocForum/docforum-core/issues/36)).
Dependency-free RFC 6238 implementation (`node:crypto`) with enrolment,
two-step login, single-use recovery codes and `TOTP_REQUIRE_FOR_ADMIN`
enforced admin enrolment. `User` gains `totpSecret` (encrypted with the
existing field-encryption key), `totpEnabledAt` and `totpLastUsedStep`, plus a
`TwoFactorRecoveryCode` table (SHA-256 hashes, single-use). Replay is blocked
by claiming the accepted time step with one conditional `updateMany`, not by
client state. Half-authenticated `mfa_pending`/`mfa_enrollment` tokens carry a
`typ` claim and are rejected by `verifyAccessToken`, so they cannot be used as
access tokens. New routes: `POST /auth/2fa/{setup,enable,verify,disable}` and
`GET /auth/2fa/status`; `POST /auth/login` now returns `mfaRequired` +
`mfaToken` (or `enrollmentRequired` + `enrollmentToken`) for such accounts.
Settings: `TOTP_ISSUER`, `TOTP_REQUIRE_FOR_ADMIN`,
`TOTP_MFA_TOKEN_TTL_MINUTES`. Tests: RFC vectors in
`tests/unit/totp.test.ts`, full flow in
`tests/integration/two-factor.test.mts`.
