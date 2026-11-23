// Security response headers (Phase 8, issue #332). HSTS is production-only:
// a browser that sees it on http://localhost would pin that host to https
// for a year and break local development. Render terminates TLS in front of
// production, so every production response reaches the browser over https.
export const securityHeaders = {
  hsts: process.env.NODE_ENV === 'production',
  hstsMaxAgeSeconds: 31_536_000,
} as const;
