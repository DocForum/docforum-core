// Integration tests for admin overview and success-metrics endpoints
// (Phase 8, issue #359).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { appointmentFactory, availabilitySlotFactory, doctorProfileFactory, userFactory } from '../factories/index.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5489;
const runId = Date.now();

const FIXED_NOW = new Date('2026-10-23T12:00:00.000Z');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-admin-metrics-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_admin_metrics_test`;
process.env.DATABASE_URL = databaseUrl;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

const emailedTokens = new Map<string, string>();

describe('admin overview and success metrics endpoints (issue #359)', () => {
  let app: App;
  let prisma: Prisma;
  let fixtures: typeof import('./helpers/fixtures.mjs');

  let adminToken: string;
  let patientToken: string;
  let doctorToken: string;
  let testPatientProfileId: string;
  let testDoctorProfileId: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_admin_metrics_test');

    execFileSync(
      process.execPath,
      [path.join(BACKEND_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      { cwd: BACKEND_ROOT, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' },
    );

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    fixtures = (await import('./helpers/fixtures.mjs')) as any;

    app = appModule.createApp();
    prisma = dbModule.prisma;
    await fixtures.installEmailCapture(emailedTokens);

    // Freeze the clock for deterministic overview age and interval metrics
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);

    const admin = await fixtures.makeAdmin(app, prisma, emailedTokens, runId);
    adminToken = admin.accessToken;

    const patient = await fixtures.makePatient(app, emailedTokens, runId);
    patientToken = patient.accessToken;
    testPatientProfileId = patient.profileId;

    const doctor = await fixtures.makeDoctor(app, prisma, emailedTokens, runId);
    doctorToken = doctor.accessToken;
    testDoctorProfileId = doctor.profileId;
  }, 120_000);

  afterAll(async () => {
    vi.useRealTimers();
    await fixtures.resetEmailSenderFixture();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('access control (admin authorization)', () => {
    it('protects GET /admin/overview: 401 for anonymous, 403 for non-admins, 200 for admin', async () => {
      const anonRes = await request(app).get('/admin/overview');
      expect(anonRes.status).toBe(401);

      const patientRes = await request(app)
        .get('/admin/overview')
        .set('Authorization', `Bearer ${patientToken}`);
      expect(patientRes.status).toBe(403);

      const doctorRes = await request(app)
        .get('/admin/overview')
        .set('Authorization', `Bearer ${doctorToken}`);
      expect(doctorRes.status).toBe(403);

      const adminRes = await request(app)
        .get('/admin/overview')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminRes.status).toBe(200);
    });

    it('protects GET /admin/metrics: 401 for anonymous, 403 for non-admins, 200 for admin', async () => {
      const validQuery = 'from=2026-09-01T00:00:00.000Z&to=2026-09-15T00:00:00.000Z';

      const anonRes = await request(app).get(`/admin/metrics?${validQuery}`);
      expect(anonRes.status).toBe(401);

      const patientRes = await request(app)
        .get(`/admin/metrics?${validQuery}`)
        .set('Authorization', `Bearer ${patientToken}`);
      expect(patientRes.status).toBe(403);

      const doctorRes = await request(app)
        .get(`/admin/metrics?${validQuery}`)
        .set('Authorization', `Bearer ${doctorToken}`);
      expect(doctorRes.status).toBe(403);

      const adminRes = await request(app)
        .get(`/admin/metrics?${validQuery}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminRes.status).toBe(200);
    });
  });

  describe('GET /admin/metrics query parameter validation', () => {
    it('rejects requests missing from or to with 400', async () => {
      const noFromRes = await request(app)
        .get('/admin/metrics?to=2026-09-15T00:00:00.000Z')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(noFromRes.status).toBe(400);

      const noToRes = await request(app)
        .get('/admin/metrics?from=2026-09-01T00:00:00.000Z')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(noToRes.status).toBe(400);
    });

    it('rejects dates without offset/time with 400', async () => {
      const badFormatRes = await request(app)
        .get('/admin/metrics?from=2026-09-01&to=2026-09-15')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(badFormatRes.status).toBe(400);
    });

    it('rejects from >= to with 400', async () => {
      const invertedRes = await request(app)
        .get('/admin/metrics?from=2026-09-15T00:00:00.000Z&to=2026-09-01T00:00:00.000Z')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(invertedRes.status).toBe(400);

      const equalRes = await request(app)
        .get('/admin/metrics?from=2026-09-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(equalRes.status).toBe(400);
    });

    it('rejects ranges exceeding 366 days with 400', async () => {
      const tooWideRes = await request(app)
        .get('/admin/metrics?from=2025-01-01T00:00:00.000Z&to=2026-02-02T00:00:00.000Z')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(tooWideRes.status).toBe(400);
    });
  });

  describe('GET /admin/overview', () => {
    it('returns empty queue counts and oldestAgeSeconds: null when queue is empty', async () => {
      const res = await request(app)
        .get('/admin/overview')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.generatedAt).toBe(FIXED_NOW.toISOString());
      expect(res.body.sections).toBeInstanceOf(Array);

      const docSection = res.body.sections.find((s: any) => s.key === 'doctor-verification');
      expect(docSection).toBeDefined();
      expect(docSection).toEqual({
        key: 'doctor-verification',
        label: 'Doctors awaiting verification',
        status: 'ok',
        count: 0,
        oldestAgeSeconds: null,
        drillDownPath: '/doctors?verificationStatus=pending',
      });
    });

    it('calculates queue count and oldest waiting item age correctly and leaks no PHI', async () => {
      // Advance fake time by 2 minutes (past 60s cache TTL, well within 15m JWT validity)
      const overviewTime = new Date(FIXED_NOW.getTime() + 120_000);
      vi.setSystemTime(overviewTime);

      // Create user and doctor profiles directly
      // Doctor 1: pending, created 2 hours ago (7200 seconds ago)
      const secretDoctorName = 'Dr. Hidden Identity Sensitive';
      const secretDoctorEmail = 'secret-doctor-phi@example.com';
      const u1 = await prisma.user.create({
        data: userFactory({ email: secretDoctorEmail, role: 'doctor' }),
      });
      await prisma.doctorProfile.create({
        data: {
          ...doctorProfileFactory(u1.id, {
            fullName: secretDoctorName,
            verificationStatus: 'pending',
          }),
          createdAt: new Date(overviewTime.getTime() - 7200 * 1000), // 2 hours before overviewTime
        },
      });

      // Doctor 2: pending, created 30 minutes ago (1800 seconds ago)
      const u2 = await prisma.user.create({
        data: userFactory({ role: 'doctor' }),
      });
      await prisma.doctorProfile.create({
        data: {
          ...doctorProfileFactory(u2.id, {
            verificationStatus: 'pending',
          }),
          createdAt: new Date(overviewTime.getTime() - 1800 * 1000), // 30 mins before overviewTime
        },
      });

      // Doctor 3: already verified (should NOT be counted in pending queue)
      const u3 = await prisma.user.create({
        data: userFactory({ role: 'doctor' }),
      });
      await prisma.doctorProfile.create({
        data: {
          ...doctorProfileFactory(u3.id, {
            verificationStatus: 'verified',
          }),
          createdAt: new Date(overviewTime.getTime() - 3600 * 1000),
        },
      });

      // Doctor 4: rejected (should NOT be counted in pending queue)
      const u4 = await prisma.user.create({
        data: userFactory({ role: 'doctor' }),
      });
      await prisma.doctorProfile.create({
        data: {
          ...doctorProfileFactory(u4.id, {
            verificationStatus: 'rejected',
          }),
          createdAt: new Date(overviewTime.getTime() - 3600 * 1000),
        },
      });

      const res = await request(app)
        .get('/admin/overview')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.generatedAt).toBe(overviewTime.toISOString());

      const docSection = res.body.sections.find((s: any) => s.key === 'doctor-verification');
      expect(docSection).toBeDefined();
      expect(docSection).toEqual({
        key: 'doctor-verification',
        label: 'Doctors awaiting verification',
        status: 'ok',
        count: 2,
        oldestAgeSeconds: 7200, // 2 hours in seconds
        drillDownPath: '/doctors?verificationStatus=pending',
      });

      // PHI leakage assertion
      const responseString = JSON.stringify(res.body);
      expect(responseString).not.toContain(secretDoctorName);
      expect(responseString).not.toContain(secretDoctorEmail);
      expect(responseString).not.toContain(u1.id);
    });
  });

  describe('GET /admin/metrics aggregation and suppression', () => {
    it('suppresses aggregate metrics when fewer than five eligible appointments qualify (< 5)', async () => {
      // Window A: 2026-08-01T00:00:00.000Z to 2026-08-15T00:00:00.000Z
      const fromStr = '2026-08-01T00:00:00.000Z';
      const toStr = '2026-08-15T00:00:00.000Z';

      // Seed 3 eligible appointments in Window A: 2 completed, 1 no_show (total 3 < 5)
      for (let i = 1; i <= 3; i++) {
        const slot = await prisma.availabilitySlot.create({
          data: availabilitySlotFactory(testDoctorProfileId, {
            startTime: new Date(`2026-08-0${i + 2}T10:00:00.000Z`),
            endTime: new Date(`2026-08-0${i + 2}T10:30:00.000Z`),
            status: 'booked',
          }),
        });
        await prisma.appointment.create({
          data: {
            ...appointmentFactory(testPatientProfileId, testDoctorProfileId, slot.id, {
              status: i === 3 ? 'no_show' : 'completed',
            }),
            createdAt: new Date('2026-08-01T08:00:00.000Z'),
          },
        });
      }

      // Also seed an in-window scheduled appointment (not eligible, must not count toward threshold)
      const scheduledSlot = await prisma.availabilitySlot.create({
        data: availabilitySlotFactory(testDoctorProfileId, {
          startTime: new Date('2026-08-06T10:00:00.000Z'),
          endTime: new Date('2026-08-06T10:30:00.000Z'),
          status: 'booked',
        }),
      });
      await prisma.appointment.create({
        data: {
          ...appointmentFactory(testPatientProfileId, testDoctorProfileId, scheduledSlot.id, {
            status: 'scheduled',
          }),
          createdAt: new Date('2026-08-01T08:00:00.000Z'),
        },
      });

      const res = await request(app)
        .get(`/admin/metrics?from=${fromStr}&to=${toStr}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.window).toEqual({
        from: fromStr,
        to: toStr,
        timeZone: 'UTC',
      });
      expect(res.body.minimumCellCount).toBe(5);

      // Verify suppression per docs/success-metrics.md
      expect(res.body.metrics.noShowRate).toEqual({
        status: 'suppressed',
        value: null,
        numerator: null,
        denominator: null,
      });
      expect(res.body.metrics.bookingLeadTimeDays).toEqual({
        status: 'suppressed',
        value: null,
        unit: 'days',
        denominator: null,
      });

      expect(res.body.metrics.timeFromSymptomToOrder).toEqual({ status: 'not_yet_available', value: null });
      expect(res.body.metrics.referralCompletionRate).toEqual({ status: 'not_yet_available', value: null });
      expect(res.body.metrics.ordersFulfilledWithinNDays).toEqual({ status: 'not_yet_available', value: null });
    });

    it('computes exact aggregate metrics for eligible appointments (>= 5) and leaks no PHI', async () => {
      // Window B: 2026-09-01T00:00:00.000Z to 2026-09-15T00:00:00.000Z
      const fromStr = '2026-09-01T00:00:00.000Z';
      const toStr = '2026-09-15T00:00:00.000Z';

      // Hand-derived seed specification:
      // 6 eligible appointments inside [from, to):
      // - 4 completed, 2 no_show.
      // - No-show rate = 2 / 6 = 1/3 (0.3333333333333333).
      // Lead times (appointmentAt - bookedAt):
      // 1: slot 2026-09-03T10:00Z, booked 2026-09-01T10:00Z -> 2 days (172,800s), completed
      // 2: slot 2026-09-04T10:00Z, booked 2026-09-02T10:00Z -> 2 days (172,800s), completed
      // 3: slot 2026-09-05T10:00Z, booked 2026-09-01T10:00Z -> 4 days (345,600s), completed
      // 4: slot 2026-09-06T10:00Z, booked 2026-09-02T10:00Z -> 4 days (345,600s), completed
      // 5: slot 2026-09-07T10:00Z, booked 2026-09-04T10:00Z -> 3 days (259,200s), no_show
      // 6: slot 2026-09-08T10:00Z, booked 2026-09-05T10:00Z -> 3 days (259,200s), no_show
      // Sum of lead times = 2 + 2 + 4 + 4 + 3 + 3 = 18 days.
      // Mean lead time = 18 / 6 = 3.0 days.
      const appointmentsData = [
        { slotStart: '2026-09-03T10:00:00.000Z', bookedAt: '2026-09-01T10:00:00.000Z', status: 'completed' as const },
        { slotStart: '2026-09-04T10:00:00.000Z', bookedAt: '2026-09-02T10:00:00.000Z', status: 'completed' as const },
        { slotStart: '2026-09-05T10:00:00.000Z', bookedAt: '2026-09-01T10:00:00.000Z', status: 'completed' as const },
        { slotStart: '2026-09-06T10:00:00.000Z', bookedAt: '2026-09-02T10:00:00.000Z', status: 'completed' as const },
        { slotStart: '2026-09-07T10:00:00.000Z', bookedAt: '2026-09-04T10:00:00.000Z', status: 'no_show' as const },
        { slotStart: '2026-09-08T10:00:00.000Z', bookedAt: '2026-09-05T10:00:00.000Z', status: 'no_show' as const },
      ];

      for (const item of appointmentsData) {
        const slot = await prisma.availabilitySlot.create({
          data: availabilitySlotFactory(testDoctorProfileId, {
            startTime: new Date(item.slotStart),
            endTime: new Date(new Date(item.slotStart).getTime() + 30 * 60_000),
            status: 'booked',
          }),
        });
        await prisma.appointment.create({
          data: {
            ...appointmentFactory(testPatientProfileId, testDoctorProfileId, slot.id, {
              status: item.status,
            }),
            createdAt: new Date(item.bookedAt),
          },
        });
      }

      // Out-of-window and non-eligible appointments that MUST NOT affect window metrics:
      // A) Before window: slot on 2026-08-31T23:59:59.000Z (< from)
      const beforeSlot = await prisma.availabilitySlot.create({
        data: availabilitySlotFactory(testDoctorProfileId, {
          startTime: new Date('2026-08-31T23:59:59.000Z'),
          endTime: new Date('2026-09-01T00:29:59.000Z'),
          status: 'booked',
        }),
      });
      await prisma.appointment.create({
        data: {
          ...appointmentFactory(testPatientProfileId, testDoctorProfileId, beforeSlot.id, {
            status: 'completed',
          }),
          createdAt: new Date('2026-08-25T10:00:00.000Z'),
        },
      });

      // B) At upper window boundary: slot exactly on 2026-09-15T00:00:00.000Z (half-open: excluded)
      const boundarySlot = await prisma.availabilitySlot.create({
        data: availabilitySlotFactory(testDoctorProfileId, {
          startTime: new Date('2026-09-15T00:00:00.000Z'),
          endTime: new Date('2026-09-15T00:30:00.000Z'),
          status: 'booked',
        }),
      });
      await prisma.appointment.create({
        data: {
          ...appointmentFactory(testPatientProfileId, testDoctorProfileId, boundarySlot.id, {
            status: 'completed',
          }),
          createdAt: new Date('2026-09-10T10:00:00.000Z'),
        },
      });

      // C) Inside window but scheduled: slot on 2026-09-09T10:00:00.000Z (must not count)
      const scheduledSlot = await prisma.availabilitySlot.create({
        data: availabilitySlotFactory(testDoctorProfileId, {
          startTime: new Date('2026-09-09T10:00:00.000Z'),
          endTime: new Date('2026-09-09T10:30:00.000Z'),
          status: 'booked',
        }),
      });
      await prisma.appointment.create({
        data: {
          ...appointmentFactory(testPatientProfileId, testDoctorProfileId, scheduledSlot.id, {
            status: 'scheduled',
          }),
          createdAt: new Date('2026-09-01T10:00:00.000Z'),
        },
      });

      const res = await request(app)
        .get(`/admin/metrics?from=${fromStr}&to=${toStr}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.window).toEqual({
        from: fromStr,
        to: toStr,
        timeZone: 'UTC',
      });
      expect(res.body.minimumCellCount).toBe(5);

      // Assert exact hand-derived numbers
      expect(res.body.metrics.noShowRate).toEqual({
        status: 'available',
        value: 2 / 6,
        numerator: 2,
        denominator: 6,
      });

      expect(res.body.metrics.bookingLeadTimeDays).toEqual({
        status: 'available',
        value: 3.0,
        unit: 'days',
        denominator: 6,
      });

      // Assert no PHI leaked in aggregate response
      const responseText = JSON.stringify(res.body);
      expect(responseText).not.toContain(testPatientProfileId);
      expect(responseText).not.toContain(testDoctorProfileId);
      expect(responseText).not.toContain('appointment');
      expect(responseText).not.toContain('patient');
    });
  });
});
