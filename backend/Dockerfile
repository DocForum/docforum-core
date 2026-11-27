FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend ./
RUN npm run prisma:generate && npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system docforum && useradd --system --gid docforum docforum
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY backend/package*.json ./
USER docforum
EXPOSE 4000

# Liveness probe (issue #345). The Debian slim image ships neither curl nor
# wget, so the probe uses Node's built-in fetch against the unauthenticated
# `/health/live` route in src/app.ts. PORT is honoured so a non-default port
# works without editing the image. No DB access, so it stays a liveness probe;
# `/health/ready` is the readiness one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/health/live').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/server.js"]
