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
export const trustProxy = parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV === 'production');
