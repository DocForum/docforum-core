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
  // TOTP two-factor auth (Phase 8 #36). The encryption key is read here but
  // deliberately NOT required at boot (same reasoning as payments below) —
  // the 2FA service itself fails loudly with a named error if it's missing
  // when a secret actually has to be encrypted or decrypted.
  twoFactor: {
    encryptionKey: process.env.TOTP_ENCRYPTION_KEY,
    issuer: process.env.TOTP_ISSUER ?? 'DocForum',
    // Short-lived, single-purpose token handed back instead of a session
    // when a password step succeeds but the TOTP step hasn't happened yet.
    // Accepted only by POST /auth/2fa/verify.
    mfaPendingTtl: '5m',
    recoveryCodeCount: 10,
    // When true, an admin account must have 2FA enabled to log in at all —
    // enforced at login. Defaults to false so enabling it can't lock out an
    // admin who hasn't enrolled yet without that being a deliberate ops
    // decision; see the bootstrap caveat in ARCHITECTURE_ESSENTIALS.md.
    requireForAdmin: process.env.REQUIRE_2FA_FOR_ADMIN === 'true',
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
