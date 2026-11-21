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
    await prisma.doctorProfile.update({
      where: { id: doctorProfileId },
      data: { verificationStatus: 'verified' },
    });

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

  it('refuses claiming past open slots on all booking paths at the DB level (issue #285)', async () => {
    const [doctor] = await prisma.doctorProfile.findMany({ where: { verificationStatus: 'verified' }, take: 1 });
    // Seed an open slot whose start time is in the past
    const pastSlot = await prisma.availabilitySlot.create({
      data: {
        doctorProfileId: doctor.id,
        status: 'open',
        startTime: new Date(Date.now() - 3600_000),
        endTime: new Date(Date.now() - 1800_000),
      },
    });

    // 1. Direct booking refuses past slot with 409
    const directRes = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patientTokens[0]}`)
      .send({ availabilitySlotId: pastSlot.id });
    expect(directRes.status).toBe(409);
    expect(directRes.body.message).toMatch(/no longer bookable/i);

    // Verify slot remains open in DB (proves conditional UPDATE where startTime > now did not touch it)
    const dbSlot = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: pastSlot.id } });
    expect(dbSlot.status).toBe('open');

    // 2. Reschedule refuses past slot with 409
    const appointments = await prisma.appointment.findMany({ where: { availabilitySlotId: slotId } });
    const apptId = appointments[0].id;

    const rescheduleRes = await request(app)
      .post(`/appointments/${apptId}/reschedule`)
      .set('Authorization', `Bearer ${patientTokens[0]}`)
      .send({ newSlotId: pastSlot.id });
    expect(rescheduleRes.status).toBe(409);
    expect(rescheduleRes.body.message).toMatch(/no longer bookable/i);

    // Slot remains open
    const dbSlotAfterReschedule = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: pastSlot.id } });
    expect(dbSlotAfterReschedule.status).toBe('open');
  });

  it('hides unverified doctors slots from public listing and refuses booking (issue #286)', async () => {
    // 1. Create an unverified doctor
    const unverifiedDocSignup = await request(app).post('/auth/signup').send({
      role: 'doctor',
      email: `unverified-doc-${runId}@example.com`,
      password: 'longenough123',
      fullName: 'Unverified Doctor',
    });
    const unverifiedToken = unverifiedDocSignup.body.accessToken as string;
    const meRes = await request(app).get('/doctors/me').set('Authorization', `Bearer ${unverifiedToken}`);
    const unverifiedDocId = meRes.body.id as string;

    // Direct seed a future open slot for this unverified doctor
    const futureSlot = await prisma.availabilitySlot.create({
      data: {
        doctorProfileId: unverifiedDocId,
        status: 'open',
        startTime: new Date(Date.now() + 48 * 3600_000),
        endTime: new Date(Date.now() + 48 * 3600_000 + 1800_000),
      },
    });

    // 2. GET /availability/doctors/:id/slots returns empty array (unverified doctor's slots not publicly listed)
    const listRes = await request(app).get(`/availability/doctors/${unverifiedDocId}/slots`);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toEqual([]);

    // 3. Direct booking refuses with 422
    const directRes = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patientTokens[1]}`)
      .send({ availabilitySlotId: futureSlot.id });
    expect(directRes.status).toBe(422);
    expect(directRes.body.message).toMatch(/doctor is not verified/i);

    // 4. Reschedule refuses with 422
    const appointments = await prisma.appointment.findMany({ where: { availabilitySlotId: slotId } });
    const apptId = appointments[0].id;
    const rescheduleRes = await request(app)
      .post(`/appointments/${apptId}/reschedule`)
      .set('Authorization', `Bearer ${patientTokens[0]}`)
      .send({ newSlotId: futureSlot.id });
    expect(rescheduleRes.status).toBe(422);
    expect(rescheduleRes.body.message).toMatch(/doctor is not verified/i);
  });

  it('prevents overlapping slots when mixing lengths and enforces DB exclusion constraint (issue #287)', async () => {
    const [doctor] = await prisma.doctorProfile.findMany({ where: { verificationStatus: 'verified' }, take: 1 });
    const availabilityService = await import('../../src/modules/availability/services/index.js');

    // 1. Generate 30-min slots for 09:00 - 11:00 on 2026-11-25 (4 slots)
    const gen30 = await availabilityService.generateSlots({
      doctorProfileId: doctor.id,
      date: '2026-11-25',
      startHour: 9,
      endHour: 11,
      slotLengthMinutes: 30,
    });
    expect(gen30.created).toBe(4);
    expect(gen30.skippedOverlapping).toBe(0);

    // 2. Generate 20-min slots over the same morning 09:00 - 11:00:
    // All 6 candidate slots overlap existing 30-min slots and must be skipped
    const gen20Same = await availabilityService.generateSlots({
      doctorProfileId: doctor.id,
      date: '2026-11-25',
      startHour: 9,
      endHour: 11,
      slotLengthMinutes: 20,
    });
    expect(gen20Same.created).toBe(0);
    expect(gen20Same.skippedOverlapping).toBe(6);

    // 3. Generate 20-min slots over 08:00 - 10:00:
    // 08:00-08:20, 08:20-08:40, 08:40-09:00 are created (3 slots)
    // 09:00-09:20, 09:20-09:40, 09:40-10:00 overlap existing 30m slots and are skipped (3 slots)
    const gen20Wider = await availabilityService.generateSlots({
      doctorProfileId: doctor.id,
      date: '2026-11-25',
      startHour: 8,
      endHour: 10,
      slotLengthMinutes: 20,
    });
    expect(gen20Wider.created).toBe(3);
    expect(gen20Wider.skippedOverlapping).toBe(3);

    // 4. Database-level exclusion constraint:
    // Direct attempt to insert an overlapping slot fails via PostgreSQL exclusion constraint
    await expect(
      prisma.availabilitySlot.create({
        data: {
          doctorProfileId: doctor.id,
          status: 'open',
          startTime: new Date('2026-11-25T09:15:00.000Z'),
          endTime: new Date('2026-11-25T09:45:00.000Z'),
        },
      }),
    ).rejects.toThrow();

    // 5. Concurrent generation calls over overlapping windows
    const results = await Promise.allSettled([
      availabilityService.generateSlots({
        doctorProfileId: doctor.id,
        date: '2026-11-26',
        startHour: 9,
        endHour: 12,
        slotLengthMinutes: 30,
      }),
      availabilityService.generateSlots({
        doctorProfileId: doctor.id,
        date: '2026-11-26',
        startHour: 10,
        endHour: 13,
        slotLengthMinutes: 20,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const totalCreated = fulfilled.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value.created : 0), 0);
    expect(totalCreated).toBeGreaterThan(0);

    // Verify in database: zero overlapping slots exist for this doctor
    const slots = await prisma.availabilitySlot.findMany({
      where: { doctorProfileId: doctor.id },
      orderBy: { startTime: 'asc' },
    });
    for (let i = 1; i < slots.length; i++) {
      if (slots[i].startTime < slots[i - 1].endTime && slots[i].endTime > slots[i - 1].startTime) {
        throw new Error(`Database contains overlapping slots: ${slots[i - 1].id} and ${slots[i].id}`);
      }
    }
  });
});
