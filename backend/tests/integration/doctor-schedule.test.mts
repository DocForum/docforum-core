// Integration tests for doctor schedule and availability guard rails (issues #288, #289, #290, #291).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5475;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-sched-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
process.env.DATABASE_URL = databaseUrl;

const emailedTokens = new Map<string, string>();

describe('doctor schedule & availability guard rails (issues #288, #289, #290, #291)', () => {
  let app: any;
  let prisma: any;
  let fixtures: any;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    fixtures = await import('./helpers/fixtures.mjs');

    app = appModule.createApp();
    prisma = dbModule.prisma;
    await fixtures.installEmailCapture(emailedTokens);
  }, 180_000);

  afterAll(async () => {
    await fixtures.resetEmailSenderFixture();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('enforces input guard rails on slot generation (issue #288)', async () => {
    const doctor = await fixtures.makeDoctor(app, prisma, emailedTokens, runId);

    // Reject past date
    const pastRes = await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({
        date: '2020-01-01',
        startHour: 9,
        endHour: 17,
        slotLengthMinutes: 30,
      });
    expect(pastRes.status).toBe(400);
    expect(pastRes.body.code).toBe('SLOT_DATE_IN_PAST');

    // Reject slotLengthMinutes below 5
    const shortRes = await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({
        date: '2026-11-28',
        startHour: 9,
        endHour: 17,
        slotLengthMinutes: 4,
      });
    expect(shortRes.status).toBe(400);

    // Reject window not cleanly divisible
    const indivisibleRes = await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({
        date: '2026-11-28',
        startHour: 9,
        endHour: 10,
        slotLengthMinutes: 45,
      });
    expect(indivisibleRes.status).toBe(400);

    // Valid generation succeeds
    const okRes = await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({
        date: '2026-11-28',
        startHour: 9,
        endHour: 12,
        slotLengthMinutes: 30,
      });
    expect(okRes.status).toBe(201);
    expect(okRes.body.created).toBe(6);
  });

  it('filters open slots by date range and clamps past from (issue #289)', async () => {
    const doctor = await fixtures.makeDoctor(app, prisma, emailedTokens, runId);

    // Generate slots for Nov 28, 2026
    await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({
        date: '2026-11-28',
        startHour: 9,
        endHour: 11,
        slotLengthMinutes: 30,
      });

    // Default range query (next 14 days)
    const defaultRes = await request(app).get(`/availability/doctors/${doctor.profileId}/slots`);
    expect(defaultRes.status).toBe(200);
    expect(Array.isArray(defaultRes.body)).toBe(true);

    // Explicit range matching Nov 28
    const rangeRes = await request(app)
      .get(`/availability/doctors/${doctor.profileId}/slots`)
      .query({
        from: '2026-11-28T00:00:00.000Z',
        to: '2026-11-28T23:59:59.000Z',
      });
    expect(rangeRes.status).toBe(200);
    expect(rangeRes.body.length).toBe(4);

    // Too wide range (>31 days) rejected
    const wideRes = await request(app)
      .get(`/availability/doctors/${doctor.profileId}/slots`)
      .query({
        from: '2026-12-01T00:00:00.000Z',
        to: '2027-01-15T00:00:00.000Z',
      });
    expect(wideRes.status).toBe(400);
    expect(wideRes.body.code).toBe('DATE_RANGE_TOO_LARGE');

    // from > to rejected
    const invertedRes = await request(app)
      .get(`/availability/doctors/${doctor.profileId}/slots`)
      .query({
        from: '2026-11-30T00:00:00.000Z',
        to: '2026-11-25T00:00:00.000Z',
      });
    expect(invertedRes.status).toBe(400);
    expect(invertedRes.body.code).toBe('INVALID_DATE_RANGE');
  });

  it('serves doctor today view in doctor local time zone and schedule endpoint across date range (issues #290, #291)', async () => {
    const doctor = await fixtures.makeDoctor(app, prisma, emailedTokens, runId);
    const otherDoctor = await fixtures.makeDoctor(app, prisma, emailedTokens, runId);
    const patient = await fixtures.makePatient(app, emailedTokens, runId);

    // Set doctor's timeZone to Africa/Lagos
    await prisma.doctorProfile.update({
      where: { id: doctor.profileId },
      data: { timeZone: 'Africa/Lagos' },
    });

    // Generate slots for today in Lagos
    const todayInLagos = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
    await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({
        date: todayInLagos,
        startHour: 9,
        endHour: 17,
        slotLengthMinutes: 60,
      });

    // Also generate slots for 5 days later
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const futureDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(futureDate);
    await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({
        date: futureDateStr,
        startHour: 9,
        endHour: 12,
        slotLengthMinutes: 60,
      });

    // Book one future slot
    const slotsRes = await request(app)
      .get(`/availability/doctors/${doctor.profileId}/slots`)
      .query({
        from: `${futureDateStr}T00:00:00.000Z`,
        to: `${futureDateStr}T23:59:59.000Z`,
      });
    const bookedSlotId = slotsRes.body[0].id;

    const bookRes = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ availabilitySlotId: bookedSlotId });
    expect(bookRes.status).toBe(201);
    const appointmentId = bookRes.body.id;

    // Doctor can view today's appointments (issue #290)
    const todayRes = await request(app)
      .get('/appointments/doctor/today')
      .set('Authorization', `Bearer ${doctor.accessToken}`);
    expect(todayRes.status).toBe(200);
    expect(Array.isArray(todayRes.body)).toBe(true);

    // Doctor can view arbitrary schedule range (issue #291)
    const scheduleRes = await request(app)
      .get('/appointments/doctor')
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .query({
        from: futureDateStr,
        to: futureDateStr,
      });
    expect(scheduleRes.status).toBe(200);
    expect(scheduleRes.body.length).toBeGreaterThanOrEqual(1);

    const schedItem = scheduleRes.body.find((a: any) => a.id === appointmentId);
    expect(schedItem).toBeDefined();
    expect(schedItem.patient.fullName).toBeDefined();
    expect(schedItem.slot.startTime).toBeDefined();
    // Zero clinical details returned
    expect((schedItem as any).intake).toBeUndefined();
    expect((schedItem as any).notes).toBeUndefined();

    // Filter by status=scheduled
    const filterRes = await request(app)
      .get('/appointments/doctor')
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .query({
        from: futureDateStr,
        to: futureDateStr,
        status: 'scheduled',
      });
    expect(filterRes.status).toBe(200);
    expect(filterRes.body.some((a: any) => a.id === appointmentId)).toBe(true);

    // Other doctor cannot view this doctor's appointments
    const otherRes = await request(app)
      .get('/appointments/doctor')
      .set('Authorization', `Bearer ${otherDoctor.accessToken}`)
      .query({
        from: futureDateStr,
        to: futureDateStr,
      });
    expect(otherRes.status).toBe(200);
    expect(otherRes.body.some((a: any) => a.id === appointmentId)).toBe(false);

    // Cancel appointment by patient
    const cancelRes = await request(app)
      .patch(`/appointments/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(cancelRes.status).toBe(200);

    // Cancelled appointment with released slot has slot: null
    const cancelledSched = await request(app)
      .get('/appointments/doctor')
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .query({
        from: todayInLagos,
        to: futureDateStr,
        status: 'cancelled',
      });
    expect(cancelledSched.status).toBe(200);
    const cancelledItem = cancelledSched.body.find((a: any) => a.id === appointmentId);
    expect(cancelledItem).toBeDefined();
    expect(cancelledItem.slot).toBeNull();
  });
});
