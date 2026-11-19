// Phase 8 hardening knobs (issues #34/#35/#37). Env-configurable so a
// preview deployment can be tightened without a code change, and so
// tests can set short windows instead of waiting real minutes.
export const auth = {
  emailVerification: {
    // How long a verification link stays usable.
    tokenTtlMinutes: Number(process.env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES ?? 24 * 60),
    // Minimum gap between two "resend verification email" requests for
    // the same account (a resend is otherwise an open email-flooding
    // button).
    resendIntervalSeconds: Number(process.env.EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS ?? 60),
    // Base URL the verification link points at. docforum-web owns the
    // page that consumes `?token=`; this is just where we send people.
    landingUrl: process.env.EMAIL_VERIFICATION_LANDING_URL ?? 'http://localhost:5173/verify-email',
  },
} as const;
