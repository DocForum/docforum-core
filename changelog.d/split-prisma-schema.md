The Prisma schema is now a folder, `backend/prisma/schema/`, with one `.prisma`
file per module (see its README) instead of one `schema.prisma` that every
feature PR edited. Models and enums moved unchanged. CI now also runs
`scripts/check-migration-drift.mjs`, which fails when the committed migrations
don't reproduce the schema.
