// THE correctness-critical test in this repo (ROADMAP.md Phase 1: "the
// single highest-priority correctness item in the whole roadmap").
//
// Fires N concurrent booking requests at the same AvailabilitySlot and
// asserts exactly one succeeds. This only proves anything against a real
// Postgres — the guarantee comes from Postgres row-level locking on the
// conditional UPDATE in availability/repositories.ts (claimOpenSlot), not
// from application logic.
//
// Self-contained: spins up its own throwaway Postgres cluster (via the
// `embedded-postgres` devDependency — a prebuilt binary, not compiled
// locally) on port 5433 and applies the committed migrations to it, so
// `npm run test:integration` needs nothing pre-existing — no Docker, no
// manually-started DB. Port 5433 (not the Postgres default 5432) so it
// can't collide with a real local Postgres a developer has running.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { availabilitySlotFactory } from '../factories/index.js';
import { runWithRlsContext, withRlsBypass } from '../../src/db/prisma-client.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.TEST_POSTGRES_PORT ?? 5433);
const CONCURRENT_PATIENTS = 8;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-test-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
  initdbFlags: ['--encoding=UTF8'],
});

// Must match vitest.config.mts's DATABASE_URL for this to be the same
// connection PrismaClient (constructed at import time, in src/db/
// prisma-client.ts) will lazily connect with on first query.
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

/** Phase 8, issue #34: booking now requires a verified email address, so
 * this test verifies each patient before it books. The verification token
 * only exists in the email (the database stores its hash), so the test
 * installs its own email sender and reads the link from the message. */
const emailedTokens = new Map<string, string>();

async function signupPatient(app: ReturnType<typeof import('../../src/app.js').createApp>, index: number) {
  const email = `patient-${runId}-${index}@example.com`;
  const res = await request(app).post('/auth/signup').send({
    role: 'patient',
    email,
    password: 'longenough123',
    fullName: `Test Patient ${index}`,
  });
  expect(res.status).toBe(200);

  const token = emailedTokens.get(email);
  expect(token, `no verification email captured for ${email}`).toBeTruthy();
  const verified = await request(app).post('/auth/verify-email').send({ token });
  expect(verified.status).toBe(200);

  return res.body.accessToken as string;
}

describe('booking concurrency', () => {
  let slotId: string;
  let patientTokens: string[];
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');

    execFileSync(process.execPath, [path.join(BACKEND_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    // Imported dynamically, after the DB exists and migrations are
    // applied — src/app.ts's import chain constructs PrismaClient at
    // module-load time, and while that connects lazily, we want the
    // schema in place before anything touches it.
    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    authServices.setEmailSender(async (message) => {
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
    });

    const doctorSignup = await request(app).post('/auth/signup').send({
      role: 'doctor',
      email: `doctor-${runId}@example.com`,
      password: 'longenough123',
      fullName: 'Test Doctor',
    });
    expect(doctorSignup.status).toBe(200);
    const doctorAccessToken = doctorSignup.body.accessToken as string;

    const doctorMe = await request(app).get('/doctors/me').set('Authorization', `Bearer ${doctorAccessToken}`);
    expect(doctorMe.status).toBe(200);
    const doctorProfileId = doctorMe.body.id as string;

    const slotStart = new Date(Date.now() + 25 * 60 * 60 * 1_000);
    const slot = await prisma.availabilitySlot.create({
      data: availabilitySlotFactory(doctorProfileId, {
        startTime: slotStart,
        endTime: new Date(slotStart.getTime() + 30 * 60_000),
      }),
    });
    slotId = slot.id;

    patientTokens = await Promise.all(Array.from({ length: CONCURRENT_PATIENTS }, (_, i) => signupPatient(app, i)));
  });

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lets exactly one of N concurrent booking attempts on the same slot succeed', async () => {
    const responses = await Promise.all(
      patientTokens.map((token) =>
        request(app).post('/appointments').set('Authorization', `Bearer ${token}`).send({ availabilitySlotId: slotId }),
      ),
    );

    const succeeded = responses.filter((res) => res.status === 201);
    const conflicted = responses.filter((res) => res.status === 409);

    expect(succeeded).toHaveLength(1);
    expect(conflicted).toHaveLength(CONCURRENT_PATIENTS - 1);

    // Not just the HTTP layer — the database must agree there's exactly
    // one Appointment for this slot, and the slot itself is `booked`.
    const appointments = await prisma.appointment.findMany({ where: { availabilitySlotId: slotId } });
    expect(appointments).toHaveLength(1);

    const slot = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slotId } });
    expect(slot.status).toBe('booked');
  });

  it('filters unscoped patient Appointment reads in PostgreSQL', async () => {
    const [{ id: appointmentId, ownerId }] = await prisma.$queryRaw<Array<{ id: string; ownerId: string }>>`
      SELECT a.id, p."userId" AS "ownerId"
      FROM "Appointment" a JOIN "PatientProfile" p ON p.id = a."patientProfileId"
      WHERE a."availabilitySlotId" = ${slotId}
    `;
    const [{ id: otherUserId }] = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "User" WHERE role = 'patient' AND id <> ${ownerId} LIMIT 1
    `;

    const [rlsState] = await runWithRlsContext({ userId: otherUserId, role: 'patient' }, () =>
      prisma.$transaction((tx) => tx.$queryRaw<Array<{ currentUser: string; userId: string; role: string }>>`
        SELECT current_user AS "currentUser",
          current_setting('app.current_user_id', true) AS "userId",
          current_setting('app.current_role', true) AS "role"
      `),
    );
    expect(rlsState).toEqual({ currentUser: 'docforum_app', userId: otherUserId, role: 'patient' });
    const databaseDenied = await runWithRlsContext({ userId: otherUserId, role: 'patient' }, () =>
      prisma.$transaction((tx) => tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Appointment" WHERE id = ${appointmentId}
      `),
    );
    expect(databaseDenied).toEqual([]);

    const denied = await runWithRlsContext({ userId: otherUserId, role: 'patient' }, () =>
      prisma.appointment.findUnique({ where: { id: appointmentId } }),
    );
    const allowed = await runWithRlsContext({ userId: ownerId, role: 'patient' }, () =>
      prisma.appointment.findUnique({ where: { id: appointmentId } }),
    );

    expect(denied).toBeNull();
    expect(allowed?.id).toBe(appointmentId);

    const samples = 5;
    const baselineStart = performance.now();
    for (let i = 0; i < samples; i++) {
      await withRlsBypass((tx) => tx.$queryRaw`SELECT id FROM "Appointment" WHERE id = ${appointmentId}`);
    }
    const baselineMs = (performance.now() - baselineStart) / samples;
    const rlsStart = performance.now();
    for (let i = 0; i < samples; i++) {
      await runWithRlsContext({ userId: ownerId, role: 'patient' }, () =>
        prisma.appointment.findUnique({ where: { id: appointmentId } }),
      );
    }
    const rlsMs = (performance.now() - rlsStart) / samples;
    console.info(`RLS booking-row read: baseline=${baselineMs.toFixed(2)}ms, scoped=${rlsMs.toFixed(2)}ms, delta=${(rlsMs - baselineMs).toFixed(2)}ms/query`);
  });
});
