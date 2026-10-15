// CSRF protection for cookie-authenticated routes (Phase 8, issue #37).
//
// The refresh token travels as an httpOnly cookie with `SameSite=None;
// Secure` (see docs/adr/0003), which means *any* site can make a browser
// send it to /auth/refresh and /auth/logout. This is the mitigation.
//
// Mitigation chosen: a per-session CSRF token that is bound into the refresh
// token itself and required in the `X-CSRF-Token` request header, plus an
// explicit Origin allowlist check and a strict per-environment CORS
// allowlist. Why this and not the classic double-submit cookie:
//
//   docforum-web is served from `docforum.github.io` and this API from
//   `*.onrender.com` — different *sites*, not just different ports. A
//   "double-submit" pattern depends on the frontend reading the cookie with
//   `document.cookie`, and it cannot: a cookie set by onrender.com is a
//   third-party cookie to github.io and is invisible to its JavaScript. The
//   value therefore travels in the login/refresh response body instead
//   (which a cross-site attacker cannot read — CORS blocks reading the
//   response), and is echoed back in a custom header. A custom header is
//   unreachable from an HTML form, forces a CORS preflight for cross-origin
//   `fetch`, and — because the expected value is a claim inside the refresh
//   token — is verified server-side against the exact session being
//   refreshed, so it also rotates with it.
import type { NextFunction, Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { HttpError } from '../http-error';

export const CSRF_HEADER = 'x-csrf-token';

/** Claim name inside the refresh token that carries the session's CSRF
 * token. Exported so the auth module signs and verifies the same name. */
export const CSRF_CLAIM = 'csrf';

export function generateCsrfToken(): string {
  // 32 bytes of CSPRNG output — not a secret that has to survive a database
  // leak (it isn't stored anywhere), but it must be unguessable so a
  // same-origin script can't forge one.
  return randomBytes(32).toString('base64url');
}

/** Length-safe constant-time comparison: a naive `===` on a secret leaks
 * its prefix through response timing. */
export function csrfTokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export function isAllowedOrigin(origin: string): boolean {
  return config.corsOrigins.includes(origin);
}

export function readCsrfHeader(req: Request): string | null {
  const header = req.get(CSRF_HEADER);
  return header && header.length > 0 ? header : null;
}

/**
 * Rejects a request whose `Origin` is present and not on the allowlist.
 *
 * Deliberately *not* the only layer: a legitimate cross-site frontend sends
 * a `cross-site` `Sec-Fetch-Site`, so that header can't be used to reject
 * anything here, and `Origin` is absent on non-browser clients. The policy
 * for a request with no `Origin` header at all (curl, server-to-server) is
 * explicit — it is allowed through this check, and must still present a
 * valid CSRF token on routes that have one to check. So an attacker's page
 * cannot win by suppressing `Origin`.
 */
export function requireAllowedOrigin(req: Request, _res: Response, next: NextFunction) {
  const origin = req.get('origin');
  if (origin && !isAllowedOrigin(origin)) {
    throw new HttpError(403, 'Origin not allowed.');
  }
  next();
}
