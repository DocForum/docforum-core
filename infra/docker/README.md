# infra/docker

Local dev DB via Docker Compose (`docker-compose.yml` — a single Postgres
16 service, matching `backend/.env.example`'s `DATABASE_URL`). Deployment
target is a separate, still-open decision — see `ARCHITECTURE.md` §8.

```bash
docker compose -f infra/docker/docker-compose.yml up -d
cd backend
cp .env.example .env
npx prisma migrate dev
```

**Not verified against a running container in this environment** — Docker
wasn't available where this was built (no `docker` binary), so the backend
was developed and its integration tests run against a locally-installed
Postgres instead. The compose file matches that same setup (same user/
password/db name as `.env.example`) but hasn't itself been exercised.
Redis isn't included — nothing needs it yet (ARCHITECTURE_ESSENTIALS.md:
"keep it simple (cron/interval) until a real job exists; don't pre-install
a queue").
