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
    accessTtl: '15m',
    refreshTtl: '30d',
  },
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:5173',
  passwordReset: {
    tokenTtlMinutes: Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES ?? 30),
    requestsPerEmailPerHour: Number(process.env.PASSWORD_RESET_REQUESTS_PER_EMAIL_PER_HOUR ?? 3),
    requestsPerIpPerHour: Number(process.env.PASSWORD_RESET_REQUESTS_PER_IP_PER_HOUR ?? 10),
  },
  auth: {
    emailVerification: {
      tokenTtlMinutes: Number(process.env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES ?? 24 * 60),
      resendIntervalSeconds: Number(process.env.EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS ?? 60),
      landingUrl: process.env.EMAIL_VERIFICATION_LANDING_URL ?? 'http://localhost:5173/verify-email',
    },
  },
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV === 'production'),
  rateLimit: {
    windowSeconds: Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60),
    maxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 100),
  },
  loginThrottle: {
    windowSeconds: Number(process.env.LOGIN_THROTTLE_WINDOW_SECONDS ?? 15 * 60),
    backoffAfterFailures: Number(process.env.LOGIN_THROTTLE_BACKOFF_AFTER ?? 3),
    backoffBaseSeconds: Number(process.env.LOGIN_THROTTLE_BACKOFF_BASE_SECONDS ?? 2),
    backoffMaxSeconds: Number(process.env.LOGIN_THROTTLE_BACKOFF_MAX_SECONDS ?? 300),
    lockAfterFailures: Number(process.env.LOGIN_THROTTLE_LOCK_AFTER ?? 10),
    lockSeconds: Number(process.env.LOGIN_THROTTLE_LOCK_SECONDS ?? 15 * 60),
    pruneIntervalSeconds: Number(process.env.LOGIN_THROTTLE_PRUNE_INTERVAL_SECONDS ?? 60 * 60),
    pruneAfterSeconds: Number(process.env.LOGIN_THROTTLE_PRUNE_AFTER_SECONDS ?? 24 * 60 * 60),
  },
  accessLog: {
    retentionDays: Number(process.env.ACCESS_LOG_RETENTION_DAYS ?? 365),
  },
  patientExport: {
    ttlHours: Number(process.env.PATIENT_EXPORT_TTL_HOURS ?? 24),
    pageSize: Number(process.env.PATIENT_EXPORT_PAGE_SIZE ?? 200),
    chunkBytes: Number(process.env.PATIENT_EXPORT_CHUNK_BYTES ?? 256 * 1024),
    workerIntervalSeconds: Number(process.env.PATIENT_EXPORT_WORKER_INTERVAL_SECONDS ?? 15),
    cleanupIntervalSeconds: Number(process.env.PATIENT_EXPORT_CLEANUP_INTERVAL_SECONDS ?? 5 * 60),
    staleAfterSeconds: Number(process.env.PATIENT_EXPORT_STALE_AFTER_SECONDS ?? 15 * 60),
    maxAttempts: Number(process.env.PATIENT_EXPORT_MAX_ATTEMPTS ?? 3),
  },
  corsOrigins: parseCorsOrigins(
    process.env.CORS_ORIGINS ?? process.env.CORS_ORIGIN,
    process.env.NODE_ENV === 'production',
  ),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? ('none' as const) : ('lax' as const),
    path: '/',
  },
  adminInvites: {
    ttlHours: Number(process.env.ADMIN_INVITE_TTL_HOURS ?? 72),
    acceptUrl: process.env.ADMIN_INVITE_ACCEPT_URL ?? 'http://localhost:5173/accept-admin-invite',
  },
  payments: {
    ...parsePaymentsConfig(process.env),
    payoutPrivacyMode,
    payoutPrivacyPoolAddress: process.env.PAYOUT_PRIVACY_POOL_ADDRESS,
  },
} as const;
