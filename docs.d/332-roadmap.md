---
file: ROADMAP.md
section: Phase 8 — Hardening (safety, audit, security)
---
- [x] Security response headers and `X-Powered-By` removal (issue #332): nosniff, `Referrer-Policy: no-referrer`, restrictive CSP, `X-Frame-Options: DENY`, `Cache-Control: no-store` on every response, HSTS in production only; unmatched routes return a JSON 404. `backend/src/middleware/security-headers.ts`.
