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
  to `main`, build: `npm install --include=dev && npx prisma generate && npm run build`,
  start: `npx prisma migrate deploy && npm start`, health check path:
  `/health/ready`. Render must use readiness, not the liveness endpoint, so
  it does not send traffic to a process whose database migrations are pending.
- Database: Render Postgres, free plan, same region (`oregon`) for
  internal networking.
- `TRUST_PROXY=1` (Phase 8, issue #35): Render terminates TLS in front of
  exactly one proxy hop. Login throttling keys on the client IP, so this has
  to be set — unset, the backend sees only the proxy address and every user
  shares one throttle bucket; `true` would let a client spoof
  `X-Forwarded-For` into a fresh bucket per request.
- `CORS_ORIGIN` set to `https://docforum.github.io` (Phase 8, issue #37
  generalised this to a comma-separated allowlist, `CORS_ORIGINS`; the
  single-origin variable still works and is honoured first if set).
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
- **Phase 8, issue #37 (follow-up):** because this cookie is genuinely
  cross-site, `/auth/refresh` and `/auth/logout` now also require the
  `X-CSRF-Token` header, and requests are checked against the CORS origin
  allowlist. `docforum-web` must keep the `csrfToken` returned by
  signup/login/refresh in memory and send it on those two calls — see
  `docs/api/README.md`. Sessions created before that change get one forced
  re-login (their refresh token has no `csrf` claim).
- **Phase 8, issue #47 (Prisma 7 upgrade):** the build and start commands
  above are unchanged and still correct, so **no manual step is needed here**.
  `npx prisma generate` and `npx prisma migrate deploy` now read the datasource
  URL from `backend/prisma.config.ts` (v7 removed `url` from the schema's
  `datasource` block and stopped loading `.env` implicitly); Render already
  injects `DATABASE_URL`, which is all that file needs. Two consequences worth
  knowing before the next deploy:
  - Render derives the web service's Node version from
    `backend/package.json`, which now declares
    `engines.node: ^20.19.0 || ^22.12.0 || >=24.0.0`. Prisma 7 requires it; an
    older Node will fail the build rather than run degraded.
  - Prisma 7 (node-postgres) validates TLS certificates, where the v6 Rust
    engine ignored invalid ones. If a deploy starts logging
    `P1010: User was denied access on the database`, that is this change, not
    a bad password — `docs/adr/0006` gives the remedy (`ssl: {
    rejectUnauthorized: false }` on the adapter to match v6 behaviour, or a
    trusted CA via `NODE_EXTRA_CA_CERTS`). Confirming this against the live
    preview is the one outstanding post-deploy check; it could not be verified
    from the contributor environment.

## Consequences

- **Free-tier limitations, accepted for a preview:** the Postgres instance
  expires 30 days after creation (current date: see "Renewing the free
  database" below) with a 14-day grace period —
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

## Renewing the free database

The free Postgres expires 30 days after creation. **Current instance
expires 2026-12-04** (renewed 2026-11-04) — update this date each time you renew. The data
is disposable preview data (see above), so renewing means starting from
an empty database, not migrating rows.

No manual migration step is needed: the web service's start command
already runs `npx prisma migrate deploy`, so a fresh database gets the
full schema on the next deploy.

Render allows only one free Postgres per workspace, so the old instance
has to be deleted **before** the new one can be created. The preview
backend is down between steps 2 and 4.

1. Note the emails of any admin/demo accounts on the old database —
   they won't carry over.
2. Old Postgres instance → **Settings** → **Delete Database**.
3. **New → Postgres**, free plan, region `oregon` (same as the web
   service, so the internal URL works). Once it's available, copy its
   **Internal Database URL**.
4. Web service → **Environment** → replace `DATABASE_URL` with that URL →
   save. If the deploy that starts is not on the latest `main` commit, use
   **Manual Deploy** → **Deploy latest commit**. `prisma migrate deploy`
   runs on start.
5. Check that `GET /health/ready` reports `ready` with `database` and
   `migrations` as `ok`, then sign up a test user through the
   `docforum-web` Pages preview to confirm the round trip (including the
   refresh cookie).
6. Re-create the admin account from a checkout's `backend/` directory, using
   the database's **External Database URL** with `?sslmode=require` added.
   Read it with `read -rs` so it stays out of shell history:

   ```sh
   read -rs 'DATABASE_URL?Paste the External URL: '
   export DATABASE_URL="${DATABASE_URL}?sslmode=require"
   node scripts/create-admin.mjs --email=<email>
   unset DATABASE_URL
   ```

   The script refuses an email that already has an account, so use one that
   hasn't signed up. A new admin's `emailVerifiedAt` is null, and no email
   provider is integrated yet (issue #17), so endpoints behind
   `requireVerifiedEmail` reject it with `403 EMAIL_NOT_VERIFIED`.
7. Update the expiry date at the top of this section (and in
   `ROADMAP.md` Phase 9).

### Required web service settings

The service won't start without `DATABASE_URL`, `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, `SEP10_SIGNING_SECRET` (a Stellar secret key),
`SEP10_HOME_DOMAIN` and `SEP10_WEB_AUTH_DOMAIN` (both
`docforum-core-api.onrender.com` here). Closing a consultation also needs
`FIELD_ENCRYPTION_KEY_V1` (32 bytes, base64); changing it makes existing
encrypted notes unreadable. These live on the web service, so renewing the
database only changes `DATABASE_URL`. Setting `ESCROW_CONTRACT_ID` also
requires `ESCROW_HEALTHCHECK_ID`.

Keep **Auto-Deploy** on, and check the **Events** tab now and then: the service
had no deploy between 2026-10-07 and 2026-11-03 despite merges to `main`, which
left 34 migrations untested on Render until this renewal.

### Restore synthetic demo data

The preview can be populated with repeatable synthetic accounts and
availability after `prisma migrate deploy`:

```sh
DEMO_SEED_PASSWORD='<at least 12 characters>' ALLOW_SYNTHETIC_SEED=true npm run db:seed
```

The seed uses `example.test` addresses and non-clinical names, and is
idempotent. `ALLOW_SYNTHETIC_SEED` is required when Render sets
`NODE_ENV=production`; never run this against a production patient database.
The seed password is supplied through the environment and is not committed.

Upgrading the existing instance to a paid plan instead keeps its data
and removes the expiry entirely; do that if renewing monthly gets old
before issue #22 picks a real production target.
