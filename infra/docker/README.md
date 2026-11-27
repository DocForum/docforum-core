# infra/docker

Local dev infrastructure via Docker Compose (`docker-compose.yml`).
It defines:

- `postgres` — PostgreSQL 16, matching `backend/.env.example`'s `DATABASE_URL`
  (`docforum`/`docforum`, database `docforum_dev`), with a `pg_isready`
  healthcheck.
- `migrate` — a one-shot service that runs `prisma migrate deploy` and exits.
  It is built from the Dockerfile's `build` stage, because the Prisma CLI is a
  devDependency and does not exist in the runtime image.
- `backend` — the production image built from `backend/Dockerfile`, with a
  container `HEALTHCHECK` that polls `GET /health/live`.

## Quick Start (Full Stack)

From a clean clone, nothing else is needed — migrations are applied
automatically before the API starts:

```bash
# 1. Build and start postgres, run migrations, then start the backend
docker compose -f infra/docker/docker-compose.yml up --build -d

# 2. Check that the one-shot migration container finished cleanly
docker compose -f infra/docker/docker-compose.yml ps
#    migrate   ...   Exited (0)
#    backend   ...   Up (healthy)

# 3. Test the running backend
curl http://localhost:4000/health/live
curl http://localhost:4000/health
curl http://localhost:4000/specialties
```

The startup ordering is enforced by Compose:

- `migrate` waits for `postgres` to be healthy (`condition: service_healthy`).
- `backend` waits for both the database healthcheck and for `migrate` to exit
  successfully (`condition: service_completed_successfully`), so it never
  starts against an un-migrated schema.

If the `migrate` container exits non-zero, the backend will not start. Read
its logs with:

```bash
docker compose -f infra/docker/docker-compose.yml logs migrate
```

`prisma migrate deploy` only applies already-committed migrations; it never
creates or edits them. To apply newly pulled migrations after a `git pull`,
re-run the one-shot service:

```bash
docker compose -f infra/docker/docker-compose.yml run --rm migrate
```

## Database Only (for local `npm run dev`)

If you prefer developing locally on your host with `tsx watch`:

```bash
# 1. Start only the postgres service
docker compose -f infra/docker/docker-compose.yml up -d postgres

# 2. Configure environment and apply migrations
cd backend
cp .env.example .env
npx prisma migrate dev

# 3. Start development server
npm run dev
```

## Production safety: migrations are local-only

The automatic migration is confined to this local Compose file. The production
image (`backend/Dockerfile`'s `runtime` stage) keeps its plain
`CMD ["node", "dist/server.js"]` and has no migrate-on-start entrypoint flag,
so a replicated production deploy never runs `prisma migrate deploy` from each
replica — replicas would race on the migration lock and a half-migrated schema
could serve traffic. Production migrations must be run as a separate, single
release step (for example `npx prisma migrate deploy` from a one-off job built
from the `build` stage) before the new replicas roll out.

## Healthchecks

- `backend` — `HEALTHCHECK` in `backend/Dockerfile` calls `/health/live` with
  Node's built-in `fetch` (the slim image has no `curl`/`wget`), every 30s
  after a 30s start period. `/health/live` is a process-liveness check with no
  database access; `/health/ready` is the readiness route. It returns `503`
  until configuration is present, the database answers, and the applied
  migration matches `backend/prisma/migrations`; its payments and
  notification-fan-out checks are reported but do not gate readiness.
- `postgres` — `pg_isready` against `docforum_dev`, every 5s.
