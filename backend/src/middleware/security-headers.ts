import type { NextFunction, Request, Response } from 'express';

export interface SecurityHeadersOptions {
  /** Send Strict-Transport-Security. True only in production (see config.securityHeaders). */
  hsts: boolean;
  hstsMaxAgeSeconds?: number;
}

/**
 * Baseline security headers for a JSON API that serves PHI (Phase 8,
 * issue #332). Set before any route runs, so a route can still override one
 * (the SSE stream adds `no-transform`, file downloads set their own type).
 *
 * - `X-Content-Type-Options: nosniff`: a JSON or file body is never
 *   re-interpreted as HTML/script by the browser.
 * - `Referrer-Policy: no-referrer`: URLs with ids never leak to third parties.
 * - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`:
 *   nothing this API returns should load anything or be framed. JSON ignores
 *   it; it only matters if an HTML page (a framework error page) slips out.
 * - `X-Frame-Options: DENY`: the same anti-framing rule for older browsers.
 * - `Cache-Control: no-store`: on every response, not just authenticated
 *   ones. Login and refresh responses carry tokens without an Authorization
 *   header, so "authenticated" can't be judged from the request; storing
 *   nothing by default is the safe side. A route that wants caching must
 *   opt in by setting its own header.
 * - `Strict-Transport-Security`: production only, never over local http.
 */
export function securityHeaders(options: SecurityHeadersOptions) {
  const hsts = options.hsts
    ? `max-age=${options.hstsMaxAgeSeconds ?? 31_536_000}; includeSubDomains`
    : null;
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    if (hsts) res.setHeader('Strict-Transport-Security', hsts);
    next();
  };
}
