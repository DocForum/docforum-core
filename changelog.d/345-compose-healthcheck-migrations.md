Phase 9: local Docker Compose now healthchecks the backend and applies
migrations automatically ([issue #345](https://github.com/DocForum/docforum-core/issues/345)).
`backend/Dockerfile` declares a `HEALTHCHECK` on `GET /health/live` using
Node's built-in `fetch` (the slim runtime image has no curl/wget).
`infra/docker/docker-compose.yml` gains a one-shot `migrate` service that runs
`prisma migrate deploy` and exits, and `backend` waits for both the Postgres
healthcheck and `service_completed_successfully` on it, so a clean clone no
longer needs a manual `npx prisma migrate deploy`. The auto-migration is
local-only: the production image keeps `CMD ["node", "dist/server.js"]` with no
migrate-on-start flag, so replicas never race to migrate. `infra/docker/README.md`
and the root README's quick start were updated. No schema or endpoint changes.
