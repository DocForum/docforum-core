import 'dotenv/config';
import { parsePaymentsConfig } from './payments';

const payoutPrivacyMode = process.env.PAYOUT_PRIVACY_MODE ?? 'facility';
if (payoutPrivacyMode !== 'facility' && payoutPrivacyMode !== 'pooled') {
  throw new Error('PAYOUT_PRIVACY_MODE must be either "facility" or "pooled".');
}

/** A strictly positive number from an env var, else the default. A typo like
 * `REFERRAL_PENDING_TTL_DAYS=0` must not silently expire every referral. */
function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/** `TRUST_PROXY` accepts what Express accepts: `true`/`false`, a hop count
 * (`1`), or a preset string (`loopback`). Absent, it defaults to `false`
 * everywhere except production, where a proxy is assumed in front. */
function parseTrustProxy(raw: string | undefined, isProduction: boolean): boolean | number | string {
  if (raw === undefined || raw === '') return isProduction ? 1 : false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** A payment asset the escrow may be denominated in (issue #79). The
 * contract id is the Stellar Asset Contract address the escrow pulls from;
 * `decimals` is informational for clients (every amount in this API is
 * already in the asset's smallest unit, so the server never scales one). */
export interface PaymentAsset {
  code: string;
  tokenContractId: string;
  decimals: number;
  /** Set for issued assets (e.g. USDC). Native XLM has none and needs no
   * trustline; every issued asset's payee must have one before funding. */
  issuer?: string;
}

// Testnet defaults. Override per environment with PAYMENT_ASSETS; production
// must set it explicitly (mainnet contract ids differ). Only assets without
// clawback, transfer fees or rebasing belong in the allowlist — escrow
// threat model T5 — and the parser refuses entries that opt into clawback or
// rebasing. This is a curated policy list, not an on-chain capability probe.
const TESTNET_NATIVE_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const TESTNET_USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const STELLAR_CONTRACT_ID = /^C[A-Z2-7]{55}$/;
const STELLAR_PUBLIC_KEY = /^G[A-Z2-7]{55}$/;

function parsePaymentAssets(raw: string | undefined): PaymentAsset[] {
  const fallback: PaymentAsset[] = [
    { code: 'XLM', tokenContractId: process.env.ESCROW_TOKEN_ID ?? TESTNET_NATIVE_SAC, decimals: 7 },
    {
      code: 'USDC',
      tokenContractId: TESTNET_USDC_SAC,
      decimals: 7,
      issuer: TESTNET_USDC_ISSUER,
    },
  ];
  if (!raw) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PAYMENT_ASSETS must be a JSON array of { code, tokenContractId, decimals, issuer? }.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('PAYMENT_ASSETS must be a non-empty JSON array.');
  }
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`PAYMENT_ASSETS[${index}] must be an object.`);
    const { code, tokenContractId, decimals, issuer, clawback, rebase } = entry as Record<string, unknown>;
    if (clawback === true || rebase === true) {
      throw new Error(`PAYMENT_ASSETS[${index}] opts into clawback/rebasing, which the escrow allowlist forbids (T5).`);
    }
    if (typeof code !== 'string' || !/^[A-Z0-9]{1,12}$/.test(code)) {
      throw new Error(`PAYMENT_ASSETS[${index}].code must be 1-12 uppercase alphanumeric characters.`);
    }
    if (seen.has(code)) throw new Error(`PAYMENT_ASSETS contains duplicate asset code ${code}.`);
    seen.add(code);
    if (typeof tokenContractId !== 'string' || !STELLAR_CONTRACT_ID.test(tokenContractId)) {
      throw new Error(`PAYMENT_ASSETS[${index}].tokenContractId must be a Stellar contract id.`);
    }
    if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw new Error(`PAYMENT_ASSETS[${index}].decimals must be an integer between 0 and 18.`);
    }
    if (issuer !== undefined && (typeof issuer !== 'string' || !STELLAR_PUBLIC_KEY.test(issuer))) {
      throw new Error(`PAYMENT_ASSETS[${index}].issuer must be a Stellar public key.`);
    }
    return { code, tokenContractId, decimals, ...(issuer ? { issuer } : {}) };
  });
}

/** Object storage driver for lab result files (Phase 5, issue #16 —
 * docs/adr/0014). `s3` talks to a private S3 bucket (or any S3-compatible
 * endpoint); `memory` is a process-local map for tests only and is refused in
 * production. Unset with no bucket configured = `none`: the server still
 * starts (the Render preview has no bucket), and the result endpoints answer
 * 503 instead of pretending to store anything. */
function parseObjectStorageDriver(
  raw: string | undefined,
  bucket: string | undefined,
  isProduction: boolean,
): 's3' | 'memory' | 'none' {
  const driver = raw && raw !== '' ? raw : bucket ? 's3' : 'none';
  if (driver !== 's3' && driver !== 'memory' && driver !== 'none') {
    throw new Error('OBJECT_STORAGE_DRIVER must be one of "s3", "memory" or "none".');
  }
  if (driver === 'memory' && isProduction) {
    throw new Error('OBJECT_STORAGE_DRIVER=memory is for tests only and is refused in production.');
  }
  if (driver === 's3' && !bucket) {
    throw new Error('OBJECT_STORAGE_DRIVER=s3 requires OBJECT_STORAGE_BUCKET.');
  }
  return driver;
}

const PRODUCTION_CORS_ORIGINS = ['https://docforum.github.io'];
const LOCAL_DEV_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

function parseCorsOrigins(raw: string | undefined, isProduction: boolean): string[] {
  if (!raw) return isProduction ? PRODUCTION_CORS_ORIGINS : LOCAL_DEV_CORS_ORIGINS;
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export interface JwtSigningKey {
  /** Key id written into the token header so verification picks the right secret. */
  kid: string;
  secret: string;
}

/**
 * Build the signing keyring for one token type. The first entry is the
 * current key (new tokens are signed with it). An optional `_PREVIOUS` secret
 * stays in the keyring during a rotation overlap, so tokens minted before the
 * rotation keep verifying until they expire. Remove `_PREVIOUS` once the
 * overlap window (the token TTL) has passed. See docs/runbooks/secret-rotation.md.
 */
function jwtSigningKeys(prefix: 'ACCESS' | 'REFRESH'): JwtSigningKey[] {
  const keys: JwtSigningKey[] = [
    {
      kid: process.env[`JWT_${prefix}_KID`] || `${prefix.toLowerCase()}-current`,
      secret: requireEnv(`JWT_${prefix}_SECRET`),
    },
  ];
  const previous = process.env[`JWT_${prefix}_SECRET_PREVIOUS`];
  if (previous) {
    keys.push({
      kid: process.env[`JWT_${prefix}_KID_PREVIOUS`] || `${prefix.toLowerCase()}-previous`,
      secret: previous,
    });
  }
  return keys;
}

const accessKeys = jwtSigningKeys('ACCESS');
const refreshKeys = jwtSigningKeys('REFRESH');

/** Issue #78: the date after which funding refuses facility wallet links
 * that were never SEP-10 verified. Defaults to 2027-01-01 (UTC) — a
 * deliberate fail-closed default: legacy links keep working for a
 * defined grace window without any deployment needing to remember to
 * set the variable, but "never enforce" is never the default. Returns
 * NaN for a malformed value so startup validation can name the var. */
function parseWalletLinkCutoff(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return Date.parse('2027-01-01T00:00:00Z');
  return Date.parse(raw);
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: requireEnv('DATABASE_URL'),
  jwt: {
    accessSecret: accessKeys[0].secret,
    refreshSecret: refreshKeys[0].secret,
    accessKeys,
    refreshKeys,
    // Short-lived access token; refresh token is the long-lived one.
    // No revocation list yet for either — see ARCHITECTURE_ESSENTIALS.md
    // "Known unresolved design gaps" (JWT refresh rotation without a
    // revocation list). A stolen refresh token has no clean kill switch
    // until that's built (Phase 8).
    accessTtl: '15m',
    refreshTtl: '30d',
  },
  // Base URL of docforum-web, used to build the link in outbound
  // notifications (password reset today). Not a provider decision — see
  // issue #17 — just the URL the recipient is sent to.
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:5173',
  passwordReset: {
    // Raw tokens are single-use and short-lived; only their SHA-256 hash
    // is stored (see PasswordResetToken in schema.prisma).
    tokenTtlMinutes: Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES ?? 30),
    // Rate limits on POST /auth/password-reset/request, so the endpoint
    // can't be used to spam an inbox. Applied per email AND per IP —
    // either limit being hit returns 429. See auth/services/rate-limit.ts
    // for the (in-memory, single-process) caveat.
    requestsPerEmailPerHour: Number(process.env.PASSWORD_RESET_REQUESTS_PER_EMAIL_PER_HOUR ?? 3),
    requestsPerIpPerHour: Number(process.env.PASSWORD_RESET_REQUESTS_PER_IP_PER_HOUR ?? 10),
  },
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
  // Express's `trust proxy` setting (Phase 8, issue #35). Login throttling
  // keys off the client IP, and a wrong setting here is a security bug in
  // both directions:
  //   - too trusting (`true`) means a client can spoof `X-Forwarded-For`
  //     and get a fresh throttle bucket per request;
  //   - not trusting at all means every request looks like it came from
  //     Render's proxy — one shared bucket for the whole internet.
  // Default: local dev has no proxy in front (false). Production is set by
  // the deployment (Render terminates TLS in front of exactly one hop), so
  // set TRUST_PROXY explicitly there; `1` is the value that matches it.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV === 'production'),
  rateLimit: {
    windowSeconds: positiveNumber(process.env.RATE_LIMIT_WINDOW_SECONDS, 60),
    maxRequests: positiveNumber(process.env.RATE_LIMIT_MAX_REQUESTS, 100),
  },
  loginThrottle: {
    // Sliding window: failures older than this don't count toward a lock.
    windowSeconds: Number(process.env.LOGIN_THROTTLE_WINDOW_SECONDS ?? 15 * 60),
    // After this many failures (still inside the window) start refusing with
    // Retry-After, growing exponentially. Deliberately below the lock
    // threshold: slow them down before locking them out.
    backoffAfterFailures: Number(process.env.LOGIN_THROTTLE_BACKOFF_AFTER ?? 3),
    backoffBaseSeconds: Number(process.env.LOGIN_THROTTLE_BACKOFF_BASE_SECONDS ?? 2),
    backoffMaxSeconds: Number(process.env.LOGIN_THROTTLE_BACKOFF_MAX_SECONDS ?? 300),
    // The actual lock, applied per normalised email (and per IP).
    lockAfterFailures: Number(process.env.LOGIN_THROTTLE_LOCK_AFTER ?? 10),
    lockSeconds: Number(process.env.LOGIN_THROTTLE_LOCK_SECONDS ?? 15 * 60),
    // Cleanup job (src/server.ts): how often to run, and how old a bucket's
    // last failure has to be before its row is dropped.
    pruneIntervalSeconds: Number(process.env.LOGIN_THROTTLE_PRUNE_INTERVAL_SECONDS ?? 60 * 60),
    pruneAfterSeconds: Number(process.env.LOGIN_THROTTLE_PRUNE_AFTER_SECONDS ?? 24 * 60 * 60),
  },
  // PHI read-access log (Phase 8, issue #45). How long AccessLog rows are
  // kept before the prune job (src/server.ts) deletes them. Reads are far
  // higher volume than AuditEvent writes, so this gets its own, shorter
  // retention instead of AuditEvent's append-forever lifetime.
  accessLog: {
    retentionDays: Number(process.env.ACCESS_LOG_RETENTION_DAYS ?? 365),
  },
  // Patient data export (Phase 8, issue #40). Env-configurable so a
  // deployment can tune retention and memory bounds without a code change.
  patientExport: {
    // How long a `ready` export stays downloadable before the cleanup job
    // deletes its artifact. Downloads are refused at expiry even if cleanup
    // hasn't run yet.
    ttlHours: Number(process.env.PATIENT_EXPORT_TTL_HOURS ?? 24),
    // Rows fetched per section page while generating — the memory bound on
    // the read side.
    pageSize: Number(process.env.PATIENT_EXPORT_PAGE_SIZE ?? 200),
    // Target size of one stored artifact chunk — the memory bound on the
    // write side and on download (one chunk is in memory at a time).
    chunkBytes: Number(process.env.PATIENT_EXPORT_CHUNK_BYTES ?? 256 * 1024),
    // Worker cadence (src/jobs/patient-exports.ts). A new request also
    // wakes the worker immediately; the interval is the restart/backlog
    // safety net.
    workerIntervalSeconds: Number(process.env.PATIENT_EXPORT_WORKER_INTERVAL_SECONDS ?? 15),
    cleanupIntervalSeconds: Number(process.env.PATIENT_EXPORT_CLEANUP_INTERVAL_SECONDS ?? 5 * 60),
    // A `processing` job whose claim is older than this is presumed dead
    // (process crashed mid-generation) and is retried, up to maxAttempts.
    staleAfterSeconds: Number(process.env.PATIENT_EXPORT_STALE_AFTER_SECONDS ?? 15 * 60),
    maxAttempts: Number(process.env.PATIENT_EXPORT_MAX_ATTEMPTS ?? 3),
  },

  // Account deletion purge (Phase 8, issue #41, docs/adr/0010). Only
  // tombstones with no retained records are ever purged; the grace period is
  // operational (lets requests in flight under a still-valid access token
  // finish), not a legal retention period — that one is an open decision.
  accountPurge: {
    graceHours: Number(process.env.ACCOUNT_PURGE_GRACE_HOURS ?? 24),
    intervalSeconds: Number(process.env.ACCOUNT_PURGE_INTERVAL_SECONDS ?? 6 * 60 * 60),
  },
  // Referral expiry (Phase 3, issue #8). A referral still `pending` this
  // long after it was created — or after it last returned to `pending` —
  // is moved to the terminal `expired` state by an interval sweep
  // (src/jobs/referral-expiry.ts). A v1 default, not a tuned value.
  referrals: {
    pendingTtlDays: positiveNumber(process.env.REFERRAL_PENDING_TTL_DAYS, 14),
    expirySweepIntervalSeconds: positiveNumber(process.env.REFERRAL_EXPIRY_SWEEP_INTERVAL_SECONDS, 60 * 60),
  },
  // Feature flags (Phase 8, issue #132). Flags are cached in memory this
  // long; an admin change takes effect immediately in the process that
  // handled it and within this many seconds in the others.
  featureFlags: {
    cacheTtlSeconds: (() => {
      const raw = Number(process.env.FEATURE_FLAG_CACHE_TTL_SECONDS);
      return Number.isFinite(raw) && raw >= 0 && process.env.FEATURE_FLAG_CACHE_TTL_SECONDS ? raw : 15;
    })(),
  },
  // Guardians and dependents (Phase 8, issue #42, docs/adr/0011). Guardian
  // access ends automatically when the dependent reaches this age (UTC
  // calendar date, checked at request time).
  patients: {
    ageOfMajorityYears: Number(process.env.AGE_OF_MAJORITY_YEARS ?? 18),
  },
  // Explicit, per-environment CORS allowlist (Phase 8, issue #37). A single
  // configured origin string was one typo away from "reflect whatever origin
  // asked"; an allowlist makes every permitted frontend a deliberate entry.
  // `CORS_ORIGINS` (comma-separated) is the preferred form; `CORS_ORIGIN` is
  // still honoured as a single-origin setting so the existing Render
  // configuration (docs/adr/0003) keeps working unchanged.
  corsOrigins: parseCorsOrigins(
    process.env.CORS_ORIGINS ?? process.env.CORS_ORIGIN,
    process.env.NODE_ENV === 'production',
  ),
  cookie: {
    // The refresh cookie is `SameSite=None; Secure` in production because
    // docforum-web (GitHub Pages) and this API (Render) are genuinely
    // different sites — see docs/adr/0003. `Secure` needs HTTPS, which local
    // dev over plain http doesn't have, hence the NODE_ENV branch. Shared
    // with the CSRF cookie so the two can never drift apart.
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? ('none' as const) : ('lax' as const),
    path: '/',
  },
  // Admin invites (Phase 8, issue #39). `acceptUrl` is where the invite link
  // points — docforum-web owns the page that consumes `?token=`.
  adminInvites: {
    ttlHours: Number(process.env.ADMIN_INVITE_TTL_HOURS ?? 72),
    acceptUrl: process.env.ADMIN_INVITE_ACCEPT_URL ?? 'http://localhost:5173/accept-admin-invite',
  },
  orders: {
    confirmationWindowHours: Number(process.env.ORDER_CONFIRMATION_WINDOW_HOURS ?? 72),
    expiryIntervalSeconds: Number(process.env.ORDER_EXPIRY_INTERVAL_SECONDS ?? 300),
  },
  // Lab result files (Phase 5, issue #16 — docs/adr/0014). The bucket must be
  // private: files are only ever served back through the API, which checks
  // access on every read. Credentials come from the AWS SDK's default chain
  // (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or an instance role) — never
  // from this object.
  objectStorage: {
    driver: parseObjectStorageDriver(
      process.env.OBJECT_STORAGE_DRIVER,
      process.env.OBJECT_STORAGE_BUCKET,
      process.env.NODE_ENV === 'production',
    ),
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? '',
    region: process.env.OBJECT_STORAGE_REGION ?? 'us-east-1',
    // Only for S3-compatible providers / local MinIO; unset = AWS S3.
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT || undefined,
    forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE === 'true',
  },
  labResults: {
    maxBytes: positiveNumber(process.env.LAB_RESULT_MAX_BYTES, 10 * 1024 * 1024),
  },
  payments: {
    ...parsePaymentsConfig(process.env),
    // Issue #79: per-environment asset allowlist (USDC + native XLM by
    // default on testnet). The legacy `escrowTokenId`/`assetAllowlist`
    // fields above remain for the pre-#79 native-XLM path.
    assets: parsePaymentAssets(process.env.PAYMENT_ASSETS),
    // Horizon is read only for payee trustline checks — never for contract
    // calls, which go through the SDK.
    horizonUrl: process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
    // Issue #80: how long a prepared, unsigned create_escrow transaction is
    // considered live before the expiry job returns the intent to `created`.
    prepareTtlSeconds: Number(process.env.PAYMENT_PREPARE_TTL_SECONDS ?? 5 * 60),
    // ADR 0005: refund_after = order expiry + grace. Orders are still
    // placeholders without an expiry field (Phase 4), so the intent's own
    // createdAt is the order-expiry anchor today.
    orderExpiryHours: Number(process.env.PAYMENT_ORDER_EXPIRY_HOURS ?? 72),
    refundGraceHours: Number(process.env.PAYMENT_REFUND_GRACE_HOURS ?? 24),
    // Expiry sweep cadence (src/jobs/payment-intents.ts).
    prepareExpirySweepIntervalSeconds: Number(process.env.PAYMENT_PREPARE_EXPIRY_SWEEP_INTERVAL_SECONDS ?? 60),
    payoutPrivacyMode,
    payoutPrivacyPoolAddress: process.env.PAYOUT_PRIVACY_POOL_ADDRESS,
    walletLinkUnverifiedFundingCutoff: parseWalletLinkCutoff(
      process.env.WALLET_LINK_UNVERIFIED_FUNDING_CUTOFF,
    ),
  },
  // SEP-10 Stellar Web Authentication (issue #77, ADR 0005 step 4).
  sep10: {
    signingSecret: process.env.SEP10_SIGNING_SECRET,
    homeDomain: process.env.SEP10_HOME_DOMAIN,
    webAuthDomain: process.env.SEP10_WEB_AUTH_DOMAIN,
    networkPassphrase: process.env.SEP10_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
    horizonUrl: process.env.SEP10_HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
    challengeTimeoutSeconds: Number(process.env.SEP10_CHALLENGE_TIMEOUT_SECONDS ?? 300),
  },
  // Structured logging (Phase 9). Level is configurable per environment;
  // tests run quiet by default so captured output stays readable.
  log: {
    level:
      process.env.LOG_LEVEL ??
      (process.env.NODE_ENV === 'test' ? 'silent' : process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    // Header carrying the request id; accepted from the client or generated.
    requestIdHeader: 'x-request-id',
  },
} as const;
