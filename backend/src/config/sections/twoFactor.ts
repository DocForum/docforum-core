// TOTP two-factor authentication (Phase 8, issue #36).
export const twoFactor = {
  /** Label shown in the authenticator app next to the account email. */
  issuer: process.env.TOTP_ISSUER ?? 'DocForum',
  /** Make 2FA mandatory for admin accounts: an admin without it can't get a
   * full session at login, only a short-lived enrolment token that can reach
   * `POST /auth/2fa/setup` + `/enable` and nothing else. Default off, so
   * existing admin accounts are not locked out by deploying this. */
  requireForAdmin: process.env.TOTP_REQUIRE_FOR_ADMIN === 'true',
  /** Lifetime of the half-authenticated `mfa_pending` / `mfa_enrollment`
   * tokens. Deliberately minutes, not the 15-minute access-token TTL. */
  mfaTokenTtlMinutes: Number(process.env.TOTP_MFA_TOKEN_TTL_MINUTES ?? 5),
  /** Single-use recovery codes issued per enrolment. */
  recoveryCodeCount: 10,
} as const;
