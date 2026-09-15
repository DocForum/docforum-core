// Generates a real migration.sql from an actual Postgres diff, without
// needing a pre-existing local dev DB. Spins up a throwaway embedded
// Postgres (used only as Prisma's required shadow database) and runs
// `prisma migrate diff` — the documented non-interactive way to generate
// migration SQL, since `prisma migrate dev` refuses to run
// non-interactively (this environment has no TTY). Same embedded-postgres
// pattern as tests/integration/booking.test.mts.
//
// Usage: node scripts/gen-migration.mjs <migration_name>
// After running, review prisma/migrations/<timestamp>_<name>/migration.sql
// before committing — this generates the SQL, it doesn't apply it to your
// real dev DB (run `npx prisma migrate deploy` or `prisma:migrate` for that).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = 5434;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-migrate-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

await pg.initialise();
await pg.start();
await pg.createDatabase('docforum_shadow');

const shadowUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_shadow`;
const name = process.argv[2] ?? 'unnamed';
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '');
const dir = path.join('prisma', 'migrations', `${timestamp}_${name}`);

try {
  const sql = execFileSync(
    'npx',
    [
      'prisma',
      'migrate',
      'diff',
      '--from-migrations',
      'prisma/migrations',
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--shadow-database-url',
      shadowUrl,
      '--script',
    ],
    { encoding: 'utf-8' },
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'migration.sql'), sql);
  console.log(`Wrote ${dir}/migration.sql`);
} finally {
  await pg.stop();
}
