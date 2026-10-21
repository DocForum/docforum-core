import 'dotenv/config';
import { parsePaymentsConfig } from './payments';

const payoutPrivacyMode = process.env.PAYOUT_PRIVACY_MODE ?? 'facility';
if (payoutPrivacyMode !== 'facility' && payoutPrivacyMode !== 'pooled') {
  throw new Error('PAYOUT_PRIVACY_MODE must be either "facility" or "pooled".');
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

const PRODUCTION_CORS_ORIGINS = ['https://docforum.github.io'];
const LOCAL_DEV_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

function parseCorsOrigins(raw: string | undefined, isProduction: boolean): string[] {
  if (!raw) return isProduction ? PRODUCTION_CORS_ORIGINS : LOCAL_DEV_CORS_ORIGINS;
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
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
  payments: {
    ...parsePaymentsConfig(process.env),
    payoutPrivacyMode,
    payoutPrivacyPoolAddress: process.env.PAYOUT_PRIVACY_POOL_ADDRESS,
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
