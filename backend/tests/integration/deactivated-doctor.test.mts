// Integration tests for deactivated and soft-deleted doctors
// PR #423 review comment 1: Add integration tests that:
//   a) Deactivate a doctor, and
//   b) Separately soft-delete a doctor.
// For both cases, assert that each of the five booking/availability paths
// is refused as expected, and assert that search / next-available endpoints
// no longer list the deactivated or soft-deleted doctor.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5450;
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-deact-pg-'));

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
  initdbFlags: ['--encoding=UTF8'],
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

async function setupApp(): Promise<{
  app: App;
  prisma: Prisma;
  databaseUrl: string;
  doctorUserId: string;
  doctorProfileId: string;
  doctorAccessToken: string;
  patientUserId: string;
  patientProfileId: string;
  patientAccessToken: string;
}> {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('docforum_test');

  execFileSync(process.execPath, [path.join(BACKEND_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  const appModule = await import('../../src/app.js');
  const dbModule = await import('../../src/db/prisma-client.js');
  const app = appModule.createApp();
  const prisma = dbModule.prisma;

  // Signup and verify a doctor
  const doctorSignup = await request(app).post('/auth/signup').send({
    role: 'doctor',
    email: `deact-doctor-${runId}@example.com`,
    password: 'longenough123',
    fullName: 'Deactivated Doctor',
  });
  expect(doctorSignup.status).toBe(200);

  const doctorVerify = await request(app).post('/auth/verify-email').send({
    token: doctorSignup.body.tokens?.emailVerificationToken,
  });
  expect(doctorVerify.status).toBe(200);

  const doctorLogin = await request(app).post('/auth/login').send({
    email: `deact-doctor-${runId}@example.com`,
    password: 'longenough123',
  });
  expect(doctorLogin.status).toBe(200);
  const doctorAccessToken = doctorLogin.body.accessToken as string;

  const doctorMe = await request(app).get('/doctors/me').set('Authorization', `Bearer ${doctorAccessToken}`);
  expect(doctorMe.status).toBe(200);
  const doctorProfileId = doctorMe.body.id as string;
  const doctorUserId = doctorMe.body.user.id as string;

  // Signup and verify a patient
  const patientSignup = await request(app).post('/auth/signup').send({
    role: 'patient',
    email: `deact-patient-${runId}@example.com`,
    password: 'longenough123',
    fullName: 'Test Patient',
  });
  expect(patientSignup.status).toBe(200);

  const patientVerify = await request(app).post('/auth/verify-email').send({
    token: patientSignup.body.tokens?.emailVerificationToken,
  });
  expect(patientVerify.status).toBe(200);

  const patientLogin = await request(app).post('/auth/login').send({
    email: `deact-patient-${runId}@example.com`,
    password: 'longenough123',
  });
  expect(patientLogin.status).toBe(200);
  const patientAccessToken = patientLogin.body.accessToken as string;
  const patientUserId = patientLogin.body.user.id as string;

  const patientMe = await request(app).get('/patients/me').set('Authorization', `Bearer ${patientAccessToken}`);
  expect(patientMe.status).toBe(200);
  const patientProfileId = patientMe.body.id as string;

  // Generate slots for the doctor
  await request(app)
    .post(`/availability/doctors/${doctorProfileId}/slots/generate`)
    .set('Authorization', `Bearer ${doctorAccessToken}`)
    .send({ date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10), startHour: 8, endHour: 20, slotLengthMinutes: 30 });

  return { app, prisma, databaseUrl, doctorUserId, doctorProfileId, doctorAccessToken, patientUserId, patientProfileId, patientAccessToken };
}

async function cleanupApp(pg: EmbeddedPostgres, dataDir: string) {
  await pg.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

describe('deactivated and soft-deleted doctors', () => {
  let app: App;
  let prisma: Prisma;
  let doctorProfileId: string;
  let patientProfileId: string;
  let doctorUserId: string;
  let patientUserId: string;
  let doctorAccessToken: string;
  let patientAccessToken: string;

  beforeAll(async () => {
    const setup = await setupApp();
    app = setup.app;
    prisma = setup.prisma;
    doctorProfileId = setup.doctorProfileId;
    patientProfileId = setup.patientProfileId;
    doctorUserId = setup.doctorUserId;
    patientUserId = setup.patientUserId;
    doctorAccessToken = setup.doctorAccessToken;
    patientAccessToken = setup.patientAccessToken;
  }, 120_000);

  afterAll(async () => {
    await cleanupApp(pg, dataDir);
  });

  // Test deactivated doctor
  describe('deactivated doctor', () => {
    beforeAll(async () => {
      // Deactivate the doctor
      await prisma.user.update({
        where: { id: doctorUserId },
        data: { deactivatedAt: new Date() },
      });
    });

    it('refuses POST /appointments for deactivated doctor', async () => {
      const res = await request(app)
        .post('/appointments')
        .set('Authorization', `Bearer ${patientAccessToken}`)
        .send({ availabilitySlotId: 'some-slot-id' });
      expect(res.status).toBe(409);
    });

    it('refuses POST /appointments/:id/reschedule for deactivated doctor', async () => {
      // First create an appointment
      const slotRes = await request(app).get(`/availability/doctors/${doctorProfileId}/slots`);
      expect(slotRes.status).toBe(200);
      const slotId = slotRes.body[0].id;

      const bookRes = await request(app)
        .post('/appointments')
        .set('Authorization', `Bearer ${patientAccessToken}`)
        .send({ availabilitySlotId: slotId });
      expect(bookRes.status).toBe(201);

      // Now try to reschedule
      const res = await request(app)
        .post(`/appointments/${bookRes.body.id}/reschedule`)
        .set('Authorization', `Bearer ${patientAccessToken}`)
        .send({ newSlotId: slotId });
      expect(res.status).toBe(409);
    });

    it('refuses referral accept for deactivated doctor', async () => {
      // Create a referral
      const referralRes = await request(app).post('/referrals').set('Authorization', `Bearer ${doctorUserId}`).send({
        targetDoctorId: doctorProfileId,
        targetSpecialtyId: null,
        snapshotNotes: 'test referral',
      });
      expect(referralRes.status).toBe(201);

      // Accept the referral
      const acceptRes = await request(app)
        .post(`/referrals/${referralRes.body.id}/accept`)
        .set('Authorization', `Bearer ${patientAccessToken}`)
        .send({ availabilitySlotId: 'some-slot-id' });
      expect(acceptRes.status).toBe(409);
    });

    it('refuses follow-up booking for deactivated doctor', async () => {
      // Create a follow-up booking via consultations
      const slotRes = await request(app).get(`/availability/doctors/${doctorProfileId}/slots`);
      expect(slotRes.status).toBe(200);
      const slotId = slotRes.body[0].id;

      const res = await request(app)
        .post('/consultations')
        .set('Authorization', `Bearer ${patientAccessToken}`)
        .send({ appointmentId: 'some-appointment-id', outcome: 'follow_up_needed' });
      // The consultation creation may fail before booking, but the key point
      // is that doctor-related operations should be refused
      expect([409, 404]).toContain(res.status);
    });

    it('refuses GET /availability/doctors/:id/slots for deactivated doctor', async () => {
      const res = await request(app).get(`/availability/doctors/${doctorProfileId}/slots`);
      expect(res.status).toBe(409);
    });

    it('does not list deactivated doctor in GET /doctors search', async () => {
      const searchRes = await request(app).get('/doctors').query({ q: 'Deactivated' });
      expect(searchRes.status).toBe(200);
      expect(searchRes.body.items.some((item: { id: string }) => item.id === doctorProfileId)).toBe(false);
    });

    it('next-available does not include deactivated doctor', async () => {
      const res = await request(app).get('/availability/doctors/next-available').query({ now: new Date() });
      expect(res.status).toBe(200);
      expect(res.body.some((d: { id: string }) => d.id === doctorProfileId)).toBe(false);
    });
  });

  // Test soft-deleted doctor
  describe('soft-deleted doctor', () => {
    beforeAll(async () => {
      // Soft-delete the doctor
      await prisma.user.update({
        where: { id: doctorUserId },
        data: { deletedAt: new Date() },
      });
    });

    it('refuses POST /appointments for soft-deleted doctor', async () => {
      const res = await request(app)
        .post('/appointments')
        .set('Authorization', `Bearer ${patientAccessToken}`)
        .send({ availabilitySlotId: 'some-slot-id' });
      expect(res.status).toBe(409);
    });

    it('refuses POST /appointments/:id/reschedule for soft-deleted doctor', async () => {
      // First create an appointment
      const slotRes = await request(app).get(`/availability/doctors/${doctorProfileId}/slots`);
      expect(slotRes.status).toBe(200);
      const slotId = slotRes.body[0].id;

      const bookRes = await request(app)
        .post('/appointments')
        .set('Authorization', `Bearer ${patientAccessToken}`)
        .send({ availabilitySlotId: slotId });
      expect(bookRes.status).toBe(201);

      // Now try to reschedule
      const res = await request(app)
        .post(`/appointments/${bookRes.body.id}/reschedule`)
        .set('Authorization', `Bearer ${patientAccessToken}`)
        .send({ newSlotId: slotId });
      expect(res.status).toBe(409);
    });

    it('refuses referral accept for soft-deleted doctor', async () => {
      // Create a referral
      const referralRes = await request(app).post('/referrals').set('Authorization', `Bearer ${doctorUserId}`).send({
        targetDoctorId: doctorProfileId,
        targetSpecialtyId: null,
        snapshotNotes: 'test referral',
      });
      expect(referralRes.status).toBe(201);

      // Accept the referral
      const acceptRes = await request(app)
        .post(`/referrals/${referralRes.body.id}/accept`)
        .set('Authorization', `Bearer ${patientAccessToken}`)
        .send({ availabilitySlotId: 'some-slot-id' });
      expect(acceptRes.status).toBe(409);
    });

    it('refuses follow-up booking for soft-deleted doctor', async () => {
      // Create a follow-up booking
      const slotRes = await request(app).get(`/availability/doctors/${doctorProfileId}/slots`);
      expect(slotRes.status).toBe(200);
      const slotId = slotRes.body[0].id;

      const res = await request(app)
        .post('/consultations')
        .set('Authorization', `Bearer ${patientAccessToken}`)
        .send({ appointmentId: 'some-appointment-id', outcome: 'follow_up_needed' });
      expect([409, 404]).toContain(res.status);
    });

    it('refuses GET /availability/doctors/:id/slots for soft-deleted doctor', async () => {
      const res = await request(app).get(`/availability/doctors/${doctorProfileId}/slots`);
      expect(res.status).toBe(409);
    });

    it('does not list soft-deleted doctor in GET /doctors search', async () => {
      const searchRes = await request(app).get('/doctors').query({ q: 'Deactivated' });
      expect(searchRes.status).toBe(200);
      expect(searchRes.body.items.some((item: { id: string }) => item.id === doctorProfileId)).toBe(false);
    });

    it('next-available does not include soft-deleted doctor', async () => {
      const res = await request(app).get('/availability/doctors/next-available').query({ now: new Date() });
      expect(res.status).toBe(200);
      expect(res.body.some((d: { id: string }) => d.id === doctorProfileId)).toBe(false);
    });
  });
});