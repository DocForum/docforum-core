import { positiveNumber, requireEnv } from '../helpers';

// HTTP server timeouts (Phase 8, issue #335), all in milliseconds.
// - keepAliveTimeout must stay above the reverse proxy's idle timeout, or
//   Node closes a pooled connection the proxy is about to reuse and the
//   client sees a 502. Render's proxy keeps idle connections for up to
//   5 minutes, so the default is just above that.
// - headersTimeout / requestTimeout bound how long a client may take to
//   send its headers / whole request (slow-loris protection). They do not
//   limit how long a response (e.g. the SSE stream) stays open.
// - requestDeadline is the per-request deadline middleware's budget for
//   producing a response on non-streaming routes (middleware/deadline.ts).
export const http = {
  keepAliveTimeout: positiveNumber(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS, 305_000),
  headersTimeout: positiveNumber(process.env.HTTP_HEADERS_TIMEOUT_MS, 30_000),
  requestTimeout: positiveNumber(process.env.HTTP_REQUEST_TIMEOUT_MS, 120_000),
  requestDeadline: positiveNumber(process.env.HTTP_REQUEST_DEADLINE_MS, 30_000),
} as const;

export const port = Number(process.env.PORT ?? 4000);
export const databaseUrl = requireEnv('DATABASE_URL');

// Base URL of docforum-web, used to build the link in outbound
// notifications (password reset today). Not a provider decision — see
// issue #17 — just the URL the recipient is sent to.
export const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:5173';
