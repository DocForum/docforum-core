// prisma.config.ts — Prisma 7 CLI configuration (see docs/adr/0006).
//
// Prisma 7 removed `url` from the schema's datasource block and stopped
// loading `.env` implicitly. This file is the CLI's source of the connection
// string for `migrate` / `generate` / `diff`, and it is where the migration
// output path lives. The application runtime does NOT read this file — it
// builds a driver adapter in src/db/prisma-client.ts.
//
// `dotenv/config` is imported explicitly because Prisma 7 dropped the
// implicit `.env` loading the v6 CLI did. Doing it here (rather than relying
// on the shell) means `npx prisma …` behaves identically for a developer with
// a `.env` and for the Render build, which only injects environment variables.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Read from process.env rather than Prisma's `env()` helper on purpose.
    // `env()` throws when the variable is missing, which would make
    // `prisma generate` require a database URL it does not use — breaking CI
    // and any contributor who runs generate before creating a `.env`. Left
    // undefined, Prisma itself fails loudly the moment a command actually
    // needs the database (`migrate deploy` / `migrate diff`), which is the
    // behaviour we want: no URL, no migration.
    url: process.env.DATABASE_URL,
    // Optional, and read straight from process.env rather than `env()` so it
    // is genuinely optional: `env()` throws when the variable is missing, and
    // we do not want `migrate deploy` / `generate` to demand a shadow DB.
    // scripts/gen-migration.mjs sets SHADOW_DATABASE_URL for the throwaway
    // embedded Postgres it spins up, replacing v6's
    // `--shadow-database-url` flag (removed in Prisma 7).
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
