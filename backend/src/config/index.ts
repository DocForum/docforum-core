import 'dotenv/config';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: requireEnv('DATABASE_URL'),
  jwt: {
    accessSecret: requireEnv('JWT_ACCESS_SECRET'),
    refreshSecret: requireEnv('JWT_REFRESH_SECRET'),
    // Short-lived access token; refresh token is the long-lived one.
    // No revocation list yet for either — see ARCHITECTURE_ESSENTIALS.md
    // "Known unresolved design gaps" (JWT refresh rotation without a
    // revocation list). A stolen refresh token has no clean kill switch
    // until that's built (Phase 8).
    accessTtl: '15m',
    refreshTtl: '30d',
  },
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  // Phase 8 hardening knobs (issues #34/#35/#37). Env-configurable so a
  // preview deployment can be tightened without a code change, and so
  // tests can set short windows instead of waiting real minutes.
  auth: {
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
  },
  // Deliberately NOT required at startup via requireEnv() — unrelated
  // parts of the app (auth, availability, etc.) shouldn't fail to boot
  // just because payments isn't configured. The payments module itself
  // (services/index.ts) validates these are present before doing
  // anything that needs them, with a clear error naming which is
  // missing. See docs/adr/0004-custodial-payments-v1.md.
  payments: {
    platformPayerSecret: process.env.PLATFORM_PAYER_SECRET,
    platformReleaserSecret: process.env.PLATFORM_RELEASER_SECRET,
    escrowContractId: process.env.ESCROW_CONTRACT_ID,
    escrowTokenId: process.env.ESCROW_TOKEN_ID,
  },
} as const;
