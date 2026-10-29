# infra/docker

Local dev infrastructure via Docker Compose (`docker-compose.yml`).
Defines a PostgreSQL 16 service matching `backend/.env.example`'s `DATABASE_URL`
and a containerized backend service built from `backend/Dockerfile`.

## Quick Start (Full Stack)

To run both the PostgreSQL database and the backend container together:

```bash
# 1. Spin up postgres and backend
docker compose -f infra/docker/docker-compose.yml up --build -d

# 2. Apply database migrations
cd backend
npx prisma migrate deploy

# 3. Test the running backend
curl http://localhost:4000/health
curl http://localhost:4000/specialties
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

**Verified functionality:**
- PostgreSQL 16 container starts up healthy with configured credentials (`docforum`/`docforum`, database `docforum_dev`).
- Prisma migrations apply cleanly against `localhost:5432`.
- Backend starts successfully, connects to Postgres, and serves endpoints on `:4000`.
- Verified end-to-end against `/health`, `/specialties`, `/auth/signup`, and `/auth/login`.
