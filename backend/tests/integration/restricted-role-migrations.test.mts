// Migrations must apply as a database owner without SUPERUSER or BYPASSRLS,
// the account a managed host such as Render provides (docs/adr/0014).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5480; // unique per integration file
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-test-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
  initdbFlags: ['--encoding=UTF8'],
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
const PROTECTED_TABLES = ['Appointment', 'PaymentIntent', 'Consultation'];

describe('migrations as a restricted database owner', () => {
  let client: Client;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('connects without superuser or BYPASSRLS, so RLS applies', async () => {
    const { rows } = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it('creates the maintenance role without the BYPASSRLS attribute', async () => {
    const { rows } = await client.query(
      "SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'docforum_rls_bypass'",
    );
    expect(rows).toEqual([{ rolcanlogin: false, rolbypassrls: false }]);
  });

  it('admits only the maintenance role through a bypass policy on each protected table', async () => {
    const { rows } = await client.query(
      `SELECT tablename FROM pg_policies
       WHERE policyname LIKE '%_rls_bypass' AND roles = '{docforum_rls_bypass}'
         AND qual = 'true' AND with_check = 'true'`,
    );
    expect(rows.map((row) => row.tablename).sort()).toEqual([...PROTECTED_TABLES].sort());
  });

  it('lets the request and maintenance roles query each protected table', async () => {
    for (const table of PROTECTED_TABLES) {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE docforum_rls_bypass');
        await expect(client.query(`SELECT count(*) FROM "${table}"`)).resolves.toBeDefined();
        await client.query('RESET ROLE');
        await client.query('SET LOCAL ROLE docforum_app');
        await expect(client.query(`SELECT count(*) FROM "${table}"`)).resolves.toBeDefined();
      } finally {
        await client.query('ROLLBACK');
      }
    }
  });
});
