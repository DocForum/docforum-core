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

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5433;
const CONCURRENT_PATIENTS = 8;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-test-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

// Must match vitest.config.mts's DATABASE_URL for this to be the same
// connection PrismaClient (constructed at import time, in src/db/
// prisma-client.ts) will lazily connect with on first query.
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

async function signupPatient(app: ReturnType<typeof import('../../src/app.js').createApp>, index: number) {
  const res = await request(app)
    .post('/auth/signup')
    .send({
      role: 'patient',
      email: `patient-${runId}-${index}@example.com`,
      password: 'longenough123',
      fullName: `Test Patient ${index}`,
    });
  expect(res.status).toBe(200);
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

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
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
    app = appModule.createApp();
    prisma = dbModule.prisma;

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

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const generate = await request(app)
      .post(`/availability/doctors/${doctorProfileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctorAccessToken}`)
      .send({ date: tomorrow, startHour: 9, endHour: 10, slotLengthMinutes: 30 });
    expect(generate.status).toBe(201);
    expect(generate.body.created).toBeGreaterThan(0);

    const slots = await request(app).get(`/availability/doctors/${doctorProfileId}/slots`);
    expect(slots.body.length).toBeGreaterThan(0);
    slotId = slots.body[0].id;

    patientTokens = await Promise.all(Array.from({ length: CONCURRENT_PATIENTS }, (_, i) => signupPatient(app, i)));
  });

  afterAll(async () => {
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
});
