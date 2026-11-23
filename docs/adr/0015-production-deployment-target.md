# ADR 0015: Production deployment target — Render, paid, behind a Blueprint

**Status:** Accepted
**Date:** 2026-11-22
**Phase:** 9 — Deploy & CI (issue #22)
**Related:** ADR 0003 (Render free tier as a **preview only** — unchanged and not
deleted), ADR 0007 (Postgres backups and the restore drill), ADR 0016
(releaser key custody)

## Context

`ARCHITECTURE.md` §8 has carried "deployment target (Fly.io / Render / AWS /
etc.) — still undecided" since Phase 0. ADR 0003 deliberately did **not**
resolve it: it deployed `backend/` to Render's free tier so `docforum-web`'s
GitHub Pages preview had a live API, and listed what that preview
explicitly is not — no secrets manager, no backups, disposable data, a
30-day free-tier database.

That preview now has a hard deadline. The free Postgres instance expires
**2026-12-04** (renewed 2026-11-04; 30 days with a 14-day grace period). The
original deadline recorded in issue #22, 2026-10-14, has already passed once
and was met by renewing rather than by deciding. A third renewal is a
renewal too far: staging and production cannot be planned on top of a
database that is deleted monthly, and the delay has started to block Phase 9
items that are otherwise ready (staging, production + secrets).

Constraints that actually shape the decision, in order:

1. **Clinical data and PHI.** Anything production holds real patient records,
   so backups must be provable (ADR 0007) and data must not live on a
   disposable instance.
2. **The application already assumes a one-hop TLS proxy.** `TRUST_PROXY=1`
   is correct on Render and is wired into login throttling
   (`ARCHITECTURE.md` §7). That is a fact about the current deployment, not a
   reason on its own to stay.
3. **CI is GitHub Actions and the build is already container-free.**
   `npm install --include=dev && npx prisma generate && npm run build`, then
   `npx prisma migrate deploy && npm start`. Any target has to run exactly
   that; the fewer moving parts, the better.
4. **A small team has to operate it.** Boring beats clever (AGENTS.md).
5. **Two environments, not one.** Staging must exist to run migrations and
   the restore drill against realistic data before production sees them.

## Decision

**Production target: Render, paid tier, one workspace, two environments
(staging and production), defined as a Render Blueprint checked into this
repo. Database: Render Postgres, paid instance type, one per environment,
same region as its web service. Secrets: Render environment groups per
environment; the values of record also live in the team password manager.
`docforum-web` and `docforum-escrow` are out of scope here.**

This is a decision to stay on Render — but on the paid product, with a
written topology and a real backup story, not on the free preview. Staying is
the deliberate choice, not a default: the alternatives were weighed and are
recorded under "Alternatives" below.

### Topology

| Piece | Staging | Production |
|---|---|---|
| Web service | `docforum-core-staging`, Starter instance type, region `oregon` | `docforum-core-production`, Starter instance type, region `oregon` |
| Database | Render Postgres, paid, `oregon` | Render Postgres, paid, `oregon`, storage autoscaling on |
| Deploy trigger | auto-deploy on push to `main` | manual "Deploy latest commit" from a tagged `v*` commit on `main` |
| Health check | `/health/ready` (never `/health/live`) | `/health/ready` |
| Instance count | 1 | 1 (horizontal scale-out is a later, separate decision) |
| Workspace plan | Render **Pro** workspace | same workspace |

The Blueprint (`render.yaml`) is the source of truth for service shape: root
dir `backend/`, build and start commands exactly as ADR 0003 records them
(they are still correct — `prisma migrate deploy` runs on start), health
check path, region, and the plan/instance type. Manual dashboard edits that
are not reflected in the Blueprint are drift and get reverted by the next
Blueprint sync.

**Why one instance, on purpose.** There is no shared cache or queue: session
state is Postgres, rate limits and idempotency keys are Postgres rows, and
the background jobs are interval sweeps over conditional UPDATEs (see
`src/jobs/README.md`), so they are already multi-process safe. Running two
instances therefore *would* work — but it doubles cost and the in-process
job timers would race more often for no benefit at v1 traffic. Scale out when
measurement says so, and at that point move the jobs behind a single worker.

**Why the Pro workspace, not Hobby.** Paid Postgres gets continuous
point-in-time recovery either way, but the recovery window is **3 days on a
Hobby workspace and 7 days on Pro**. Seven days is the minimum that survives
a "we noticed on Monday that something broke last Wednesday" incident. Pro
also unlocks preview environments, which the frontend repo can use later
without another platform decision.

### Database: expiry gone, two layers of backup

Both instances are **paid** instance types. That removes the free-tier
30-day expiry entirely — the deadline in this ADR's Context does not recur.

- **Point-in-time recovery (platform, continuous).** Render backs up paid
  Postgres continuously; a restore creates a *new* instance at a chosen
  moment, at least 10 minutes in the past, which can be validated before
  anything points at it. This is the first line and covers the common
  failure (a bad migration, a bulk update with the wrong `WHERE`).
- **Encrypted logical dumps (ours, off-platform).** Render does **not**
  produce automatic daily logical backups on paid instances, and PITR lives
  on the same provider as the data. ADR 0007's `scripts/backup-postgres.sh`
  (gpg-encrypted `pg_dump`, 14-day retention) therefore runs daily against
  the *production* database and writes to object storage outside Render
  (the S3 bucket already used for lab-result attachments, under a
  different prefix and access key). `scripts/restore-drill.sh` runs weekly
  against staging backups — the same drill that exists today, now pointed at
  a real environment instead of a throwaway.

RPO/RTO: the ADR 0007 targets still hold. With PITR the worst-case RPO falls
from 24 hours to minutes for provider-side incidents; the off-platform dump
is what protects against "the account is gone", with its existing 24-hour
RPO. RTO stays 60 minutes, and the drill is what keeps that claim honest.

Deploys run `prisma migrate deploy` **on start**, so a migration that takes a
table lock will delay the readiness check rather than serve a half-migrated
schema. Migrations that rewrite large tables must therefore be split into
expand/contract pairs — the same rule already implied by the migration
policy in `ARCHITECTURE.md` §7.

### Secrets management

Runtime secrets live in **Render environment groups**, one per environment
(`docforum-staging`, `docforum-production`), attached to the Blueprint. They
are not in the repo and not in CI logs.

- **Source of record:** every value is stored in the team password manager
  under the environment + service it belongs to. The platform copy is the
  runtime copy; the password-manager copy is what restores the environment
  if the platform account is lost.
- **Separation:** staging and production never share a secret. Separate
  `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` (rotatable without invalidating
  the other environment), separate `FIELD_ENCRYPTION_KEY_V1` (rotating it
  makes existing encrypted consultation notes unreadable — `rotate-field-keys.mjs`
  is the only supported path), separate database credentials, separate
  `BACKUP_ENCRYPTION_KEY`.
- **Generation:** secrets are generated by the repo's own scripts
  (`scripts/gen-field-key.mjs`, `scripts/gen-platform-identities.mjs`) or by
  the platform, never typed by hand and never copied from `.env.example`
  placeholders.
- **Access:** only Render workspace owners can read environment variables.
  TOTP two-factor is required on both the Render workspace and the GitHub org
  that owns the deploy hooks; deploy hooks themselves are stored as GitHub
  Actions secrets.
- **CI/CD:** GitHub Actions needs exactly the deploy hook for each service
  (plus `BACKUP_ENCRYPTION_KEY` and object-storage credentials for the
  scheduled backup job). CI test jobs use only throwaway values — no
  production secret is ever exposed to a pull request from a fork.
- **Rotation:** documented as a runbook in `infra/backup/README.md` and the
  Render service's own README, exercised at least once before real patient
  data lands. Escrow signing keys are **not** covered here — see ADR 0016,
  which decides their custody separately because a leaked releaser key can
  move money.

This is deliberately not a KMS/HSM. Render environment groups have no audit
log and no per-secret versioning, and that gap is acceptable for JWT
signing keys and database credentials when the workspace is 2FA-protected
and the values have an offline copy. It is **not** acceptable for the escrow
signing secrets, which is exactly why ADR 0016 exists.

### Environments

- **Local:** Docker Compose (`infra/docker/`), unchanged.
- **Preview:** the existing Render free-tier service from ADR 0003, kept as
  a preview for `docforum-web`. It is *not* upgraded into production and
  its database stays disposable. Once production exists, the preview may
  keep rotating free databases on the documented schedule, or be pointed at
  a small paid instance if the churn becomes annoying — either way it never
  holds real data.
- **Staging:** auto-deploys `main`. Migrations, the restore drill and the
  synthetic seed (`ALLOW_SYNTHETIC_SEED=true` with a non-production
  password) run here first. Synthetic `example.test` accounts only; never
  real PHI.
- **Production:** deploy from a tagged commit, after staging has run the
  same migrations. No synthetic seed. Admin bootstrap is
  `scripts/create-admin.mjs`, not a SQL `UPDATE` (ADR 0003's renewal runbook
  used the latter — that was a preview-only shortcut).

### Cost, honestly

At the time of writing this is roughly **$50–$90/month** for the two
environments (two Starter web services plus two paid Postgres instances, no
HA replicas). Prices change; the Blueprint is the place to check. This is the
price of removing the expiry and having a staging environment; if it is too
much, the honest options are "one environment until launch" or a smaller
Postgres instance on staging, not a return to free-tier production.

### Migration order (before the 2026-12-04 expiry)

1. Create the Pro workspace, the two paid Postgres instances and the two web
   services from the Blueprint. No data is migrated — the preview database
   is synthetic and disposable (ADR 0003).
2. Set the environment groups; run `prisma migrate deploy` (the start
   command already does it) and confirm `GET /health/ready` reports
   `database` and `migrations` as `ok`.
3. Create the admin with `scripts/create-admin.mjs`, then run the restore
   drill against staging and a backup+restore against production once.
4. Point `docforum-web`'s staging API base URL at the staging service;
   production follows when the web app has a production build.
5. Only then let the preview's free database expire or be rotated as
   documented. **Production never depends on it.**

## Consequences

- §8's open item is closed. Staging and production can be scoped against a
  real topology instead of a placeholder.
- The recurring cost becomes a real line item (~$50–$90/month). That is the
  trade for no expiry, PITR, and a staging environment.
- The platform-specific facts ADR 0003 recorded (one proxy hop, readiness
  health check, `SameSite=None; Secure` refresh cookie cross-site) all carry
  over unchanged, because the target is the same platform and the same
  topology shape.
- **Provider coupling.** The `TRUST_PROXY=1` assumption, the internal
  database URL, and the Blueprint are Render-specific. Moving to another
  provider later is a contained change (one proxy setting, one connection
  string, one CI job), but it is a change — there is no portability claim
  here.
- The production deploy is manual (tagged commit). That is deliberate while
  the team is small; it becomes auto-deploy when there is an on-call story.
- Still explicitly out of scope: multi-region, read replicas, WAF/CDN, a
  dedicated KMS/HSM, and a shared queue. None are blocked by this decision;
  all need their own.

## Alternatives considered

- **Fly.io for the app, Neon for Postgres.** Good technical fit (Neon
  branching would make per-PR databases trivial, and its PITR window is
  generous). Rejected for v1 because it splits one decision into two
  vendors, adds a cross-provider network hop for every query, and buys
  branching the team does not yet need — while losing the "same region,
  internal URL, one dashboard" property that made the preview work. Revisit
  if per-PR environments become a requirement.
- **AWS (ECS/Fargate + RDS + Secrets Manager).** The strongest secrets story
  of the three and the least surprising for a health-adjacent product, but
  it needs VPC, IAM, ALB and task-definition work before the first staging
  deploy, and that is a project of its own. A reasonable later move when
  compliance asks for a KMS with an audit trail; the container image already
  exists (`backend/Dockerfile`).
- **Stay on the free tier and keep renewing monthly.** Rejected outright:
  the data is deleted on expiry, there are no backups, and the monthly
  renewal is the exact deadline this ADR exists to end.
- **Kubernetes.** Rejected as overengineering for two services and one
  database; `ARCHITECTURE.md` §6.3 already flags infrastructure ceremony
  before there is a reason for it.
