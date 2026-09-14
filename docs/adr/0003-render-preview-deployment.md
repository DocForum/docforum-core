# ADR 0003: Render as a preview deployment (not the Phase 9 decision)

Status: Accepted
Date: 2026-09-14

## Context

`docforum-web`'s GitHub Pages UI preview (ADR-adjacent — see its own
`ARCHITECTURE_ESSENTIALS.md` "Deployment" section) had no live backend to
talk to: `docforum-core` only ran locally. `ARCHITECTURE.md` §8 lists the
deployment target as an explicit, still-open non-decision.

## Decision

Deployed `docforum-core`'s `backend/` to Render (free tier) as a **preview
only** — this does not resolve ARCHITECTURE.md §8. It exists so the
GitHub Pages UI preview has a real backend to call, nothing more.

- Web service: Node, free plan, root dir `backend/`, auto-deploys on push
  to `main`, build: `npm install && npx prisma generate && npm run build`,
  start: `npx prisma migrate deploy && npm start`.
- Database: Render Postgres, free plan, same region (`oregon`) for
  internal networking.
- `CORS_ORIGIN` set to `https://docforum.github.io`.
- `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`: Render-generated random
  values, distinct from the dev placeholders in `.env.example`.
- Refresh-token cookie (`backend/src/modules/auth/controllers/index.ts`)
  is now genuinely environment-aware: `SameSite=None; Secure` when
  `NODE_ENV=production` (set by Render), `SameSite=Lax`/insecure for
  local dev over plain HTTP. GitHub Pages and Render are different
  domains — this is real cross-site, not just cross-port, so `Secure` +
  `SameSite=None` is required for the cookie to be sent/received at all.
- `docforum-web`'s `api-client.ts` now sends `credentials: 'include'`
  (previously missing — flagged in that repo's `ARCHITECTURE_ESSENTIALS.md`
  as a known gap before this ADR).

## Consequences

- **Free-tier limitations, accepted for a preview:** the Postgres instance
  expires 30 days after creation (2026-10-14) with a 14-day grace period —
  it will need recreating or upgrading before then, or the preview breaks.
  The web service spins down after 15 minutes of inactivity (~1 minute
  cold-start on the next request).
- **Not staging, not production.** No secrets manager, no backup policy,
  no monitoring, single free-tier instance. ARCHITECTURE.md §8's real
  deployment-target decision (Fly.io / Render / AWS / etc., for an actual
  production topology) is still open — this ADR doesn't answer it, it
  answers "how does the Pages preview reach a live backend today."
- CORS is locked to the Pages origin specifically — a second frontend
  origin (e.g. a future local dev server hitting the hosted API, or a
  custom domain) needs `CORS_ORIGIN` updated or turned into a list.
- Data on the hosted Postgres instance is disposable preview data, not
  subject to any retention/backup guarantee — do not point real users or
  real PHI at this deployment.
