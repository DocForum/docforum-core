import { requireEnv } from '../helpers';

// Render's proxy idle timeout is 5 minutes; keep-alive above that.
// See: https://render.com/docs/proxies#idle-timeout
export const http = {
  keepAliveTimeout: Number(process.env.KEEP_ALIVE_TIMEOUT ?? 300_000), // 5 minutes
  headersTimeout: Number(process.env.HEADERS_TIMEOUT ?? 30_000), // 30 seconds
  requestTimeout: Number(process.env.REQUEST_TIMEOUT ?? 120_000), // 2 minutes
} as const;

export const port = Number(process.env.PORT ?? 4000);
export const databaseUrl = requireEnv('DATABASE_URL');

// Base URL of docforum-web, used to build the link in outbound
// notifications (password reset today). Not a provider decision — see
// issue #17 — just the URL the recipient is sent to.
export const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:5173';
