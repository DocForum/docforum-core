// Proves the committed migrations and prisma/schema.prisma have not drifted.
//
// Phase 8, issue #47 — added alongside the Prisma 6 -> 7 upgrade, which is the
// kind of change that can silently invalidate a migration history (a
// generator/datasource move, a CLI that renders diffs differently, or a
// schema edit that never got its own migration). The issue's review checklist
// asks for exactly this check, so it is a script rather than a one-off command
// someone has to reconstruct.
//
// Applies the committed migrations to a throwaway embedded Postgres with
// `prisma migrate deploy` — the same command Render's start command runs —
// then diffs that live database against the schema. `--exit-code` makes the
// diff's emptiness machine-checkable: 0 = no drift, 2 = drift.
//
// Self-contained (no local dev DB, no Docker), same embedded-postgres pattern
// as tests/integration/*.test.mts and gen-migration.mjs. Not wired into CI:
// it spins its own Postgres cluster, and CI already runs the integration
// suite's clusters. Run it manually before/with a schema or Prisma upgrade:
//
//   node scripts/check-migration-drift.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = 5439; // distinct from the integration suites (5433/5435-5438) and gen-migration.mjs (5434)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-drift-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

await pg.initialise();
await pg.start();
await pg.createDatabase('docforum_drift');

const env = { ...process.env, DATABASE_URL: `postgresql://docforum:docforum@localhost:${PORT}/docforum_drift` };

try {
  console.log('Applying committed migrations with `prisma migrate deploy`…');
  process.stdout.write(execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env, encoding: 'utf-8' }));

  console.log('Diffing the migrated database against prisma/schema.prisma…');
  let diffOutput = '';
  let exitCode = 0;
  try {
    diffOutput = execFileSync(
      'npx',
      ['prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'],
      { env, encoding: 'utf-8' },
    );
  } catch (error) {
    // `--exit-code` returns 2 when the diff is non-empty, which execFileSync
    // surfaces as a thrown error carrying the output we want to show.
    exitCode = error.status ?? 1;
    diffOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }

  console.log(diffOutput.trim() || '(no diff output)');

  if (exitCode === 0) {
    console.log('\nOK — no drift: the migrations reproduce the schema exactly.');
  } else {
    console.error('\nFAILED — the migrated database differs from prisma/schema.prisma.');
    console.error('A schema change is missing its migration. Run `node scripts/gen-migration.mjs <name>` and commit the result.');
    process.exitCode = 1;
  }
} finally {
  await pg.stop();
}
