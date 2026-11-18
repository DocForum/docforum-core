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
const SEEDED_APPOINTMENTS = 5;

describe('migrations as a restricted database owner', () => {
  let client: Client;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let runWithRlsContext: typeof import('../../src/db/prisma-client.js').runWithRlsContext;
  let withRlsBypass: typeof import('../../src/db/prisma-client.js').withRlsBypass;
  let getSuccessMetrics: typeof import('../../src/modules/metrics/services/index.js').getSuccessMetrics;
  let patientUserId: string;
  const slotStart = new Date('2026-06-15T10:00:00.000Z');

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

    process.env.DATABASE_URL = databaseUrl;
    const prismaModule = await import('../../src/db/prisma-client.js');
    const metricsModule = await import('../../src/modules/metrics/services/index.js');
    ({ prisma, runWithRlsContext, withRlsBypass } = prismaModule);
    ({ getSuccessMetrics } = metricsModule);

    await withRlsBypass(async (tx) => {
      const doctorUser = await tx.user.create({ data: { email: 'doctor@example.com', passwordHash: 'x', role: 'doctor' } });
      const doctor = await tx.doctorProfile.create({
        data: { userId: doctorUser.id, fullName: 'Test Doctor', verificationStatus: 'verified', timeZone: 'UTC' },
      });
      for (let index = 0; index < SEEDED_APPOINTMENTS; index += 1) {
        const patientUser = await tx.user.create({
          data: { email: `patient-${index}@example.com`, passwordHash: 'x', role: 'patient' },
        });
        if (index === 0) patientUserId = patientUser.id;
        const patient = await tx.patientProfile.create({ data: { userId: patientUser.id, fullName: `Patient ${index}` } });
        const startTime = new Date(slotStart.getTime() + index * 60 * 60 * 1000);
        const slot = await tx.availabilitySlot.create({
          data: { doctorProfileId: doctor.id, startTime, endTime: new Date(startTime.getTime() + 30 * 60 * 1000) },
        });
        await tx.appointment.create({
          data: { patientProfileId: patient.id, doctorProfileId: doctor.id, availabilitySlotId: slot.id, status: 'completed' },
        });
      }
    });
  });

  afterAll(async () => {
    await client?.end();
    await prisma?.$disconnect();
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

  it('limits patients to their own rows and hides rows from anonymous requests', async () => {
    const patientRows = await runWithRlsContext({ userId: patientUserId, role: 'patient' }, () =>
      prisma.appointment.findMany(),
    );
    expect(patientRows).toHaveLength(1);

    const anonymousRows = await runWithRlsContext({ userId: '', role: 'anonymous' }, () =>
      prisma.appointment.findMany(),
    );
    expect(anonymousRows).toHaveLength(0);
  });

  it('lets the maintenance role see every row', async () => {
    const count = await withRlsBypass((tx) => tx.appointment.count());
    expect(count).toBe(SEEDED_APPOINTMENTS);
  });

  it('counts appointments in admin success metrics', async () => {
    const result = await runWithRlsContext({ userId: 'admin', role: 'admin' }, () =>
      getSuccessMetrics(new Date('2026-06-01T00:00:00.000Z'), new Date('2026-07-01T00:00:00.000Z')),
    );
    expect(result.metrics.noShowRate.denominator).toBe(SEEDED_APPOINTMENTS);
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
