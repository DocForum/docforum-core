// Integration tests for issue #4: closing a consultation, exactly once.
// (ROADMAP.md Phase 2 — "`Consultation` record + outcome".)
//
// The correctness-critical assertions here are:
//   1. the owning doctor can close their appointment's consultation once,
//      and only after the appointment is `completed`;
//   2. a second close is refused AND the database still holds exactly one
//      row — the unique constraint on Consultation.appointmentId is the
//      guarantee, not the service's pre-check. The two addresses for that
//      write (`POST /appointments/:id/consultation` and `POST /consultations`)
//      are the same operation, so neither can slip a second row past it;
//   3. another doctor cannot close it (404, not 403 — no existence leak).
//
// Self-contained like the other integration suites: spins up its own
// throwaway Postgres (embedded-postgres, prebuilt binary) and applies the
// committed migrations, so no pre-existing DB/Docker is needed. The port has
// to be unique per integration file — two embedded clusters on one port hang
// each other's beforeAll until the hook timeout kills the file. Taken today:
// 5433 booking, 5435 email-verification, 5436 login-throttle, 5437 csrf,
// 5438 access-control, 5439 admin-lifecycle, 5440 payments-bigint,
// 5441 audit, 5442 patient-export, 5443 referral-loops, 5444 admin-referrals,
// 5445 referral-foundation, 5446 referral-cascade, 5447 referral-multi,
// 5451 sessions, 5452 this file.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5452;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-consult-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: true,
  initdbFlags: ['-E', 'UTF8'],
});

// Matches vitest.config.mts's DATABASE_URL convention: the client built at
// import time in src/db/prisma-client.ts connects lazily with this URL.
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
// vitest.config.mts points DATABASE_URL at booking.test.mts's cluster
// (5433); this file runs its own on 5452, so it has to say so before
// src/db/prisma-client.ts constructs the client at import time. Without
// this the app talks to whatever is on 5433 — nothing when the file runs
// alone (ECONNREFUSED), and *booking's* database when the suite runs in
// parallel, which would make these assertions pass against the wrong DB.
process.env.DATABASE_URL = databaseUrl;

/** Booking requires a verified email (Phase 8, issue #34), so the suite
 * installs its own email sender and reads the verification token out of the
 * message — the DB only stores the token's hash. */
const emailedTokens = new Map<string, string>();

type App = ReturnType<typeof import('../../src/app.js').createApp>;

async function signupAndVerify(app: App, role: 'doctor' | 'patient', email: string, fullName: string) {
  const res = await request(app).post('/auth/signup').send({ role, email, password: 'longenough123', fullName });
  expect(res.status, JSON.stringify(res.body)).toBe(200);

  const token = emailedTokens.get(email);
  expect(token, `no verification email captured for ${email}`).toBeTruthy();
  const verified = await request(app).post('/auth/verify-email').send({ token });
  expect(verified.status).toBe(200);

  return res.body.accessToken as string;
}

describe('consultation close-once guarantee', () => {
  let app: App;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let owningDoctorToken: string;
  let otherDoctorToken: string;
  let patientToken: string;
  let doctorProfileId: string;
  let appointmentId: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');

    execFileSync(process.execPath, [path.join(BACKEND_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    // Imported dynamically, after migrations exist: src/app.ts's import chain
    // constructs PrismaClient at module-load time.
    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    authServices.setEmailSender(async (message) => {
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
    });

    owningDoctorToken = await signupAndVerify(app, 'doctor', `consult-doctor-${runId}@example.com`, 'Owning Doctor');
    otherDoctorToken = await signupAndVerify(app, 'doctor', `consult-other-${runId}@example.com`, 'Other Doctor');
    patientToken = await signupAndVerify(app, 'patient', `consult-patient-${runId}@example.com`, 'Test Patient');

    const doctorMe = await request(app).get('/doctors/me').set('Authorization', `Bearer ${owningDoctorToken}`);
    expect(doctorMe.status).toBe(200);
    doctorProfileId = doctorMe.body.id as string;

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const generate = await request(app)
      .post(`/availability/doctors/${doctorProfileId}/slots/generate`)
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ date: tomorrow, startHour: 9, endHour: 10, slotLengthMinutes: 30 });
    expect(generate.status, JSON.stringify(generate.body)).toBe(201);
    expect(generate.body.created).toBeGreaterThan(0);

    const slots = await request(app).get(`/availability/doctors/${doctorProfileId}/slots`);
    expect(slots.body.length).toBeGreaterThan(0);

    const book = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ availabilitySlotId: slots.body[0].id });
    expect(book.status, JSON.stringify(book.body)).toBe(201);
    appointmentId = book.body.id as string;
  }, 120_000);

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    try {
      await pg.stop();
    } catch (_err) {
      void _err;
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (_err) {
      void _err;
    }
  });

  async function makeCompletedAppointment() {
    const slot = await prisma.availabilitySlot.create({
      data: {
        doctorProfileId,
        startTime: new Date(Date.now() - 3600_000),
        endTime: new Date(Date.now() - 1800_000),
        status: 'open',
      },
    });
    const book = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ availabilitySlotId: slot.id });
    expect(book.status).toBe(201);
    const apptId = book.body.id as string;
    const complete = await request(app)
      .patch(`/appointments/${apptId}/status`)
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ status: 'completed' });
    expect(complete.status).toBe(200);
    return apptId;
  }

  it('refuses to close a consultation before the appointment is completed', async () => {
    const res = await request(app)
      .post(`/appointments/${appointmentId}/consultation`)
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ outcome: 'resolved', notes: 'Too early — the visit has not happened.' });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.message.toLowerCase()).toContain('completed');
    expect(await prisma.consultation.count({ where: { appointmentId } })).toBe(0);
  });

  it('lets the treating doctor complete the appointment', async () => {
    await prisma.availabilitySlot.updateMany({
      where: { appointment: { id: appointmentId } },
      data: { startTime: new Date(Date.now() - 60000) },
    });
    const res = await request(app)
      .patch(`/appointments/${appointmentId}/status`)
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ status: 'completed' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('completed');
  });

  it('lets the owning doctor close the appointment consultation once', async () => {
    const res = await request(app)
      .post(`/appointments/${appointmentId}/consultation`)
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ outcome: 'resolved', notes: 'Reviewed results; no follow-up needed.' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.consultation).toMatchObject({
      id: expect.any(String),
      appointmentId,
      outcome: 'resolved',
    });
    // The caller gets their own notes back in plaintext…
    expect(res.body.consultation.notes).toBe('Reviewed results; no follow-up needed.');

    // …while the column itself only ever holds the AES-GCM envelope
    // (issue #46), never the clinical text.
    const stored = await prisma.consultation.findUniqueOrThrow({ where: { appointmentId } });
    expect(stored.notes).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(stored.notes).not.toContain('Reviewed results');

    // The close is audited, in the same transaction (Phase 8, issue #43).
    const events = await prisma.auditEvent.findMany({
      where: { entityType: 'Consultation', entityId: res.body.consultation.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('consultation.closed');
    expect(events[0].toState).toBe('resolved');
  });

  it('refuses a second close of the same appointment', async () => {
    const res = await request(app)
      .post(`/appointments/${appointmentId}/consultation`)
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ outcome: 'follow_up_needed', notes: 'Second attempt — must be rejected.' });

    expect(res.status).toBe(409);
    expect(res.body.message.toLowerCase()).toContain('already');
  });

  it('still holds exactly one consultation row for the appointment', async () => {
    const rows = await prisma.consultation.findMany({ where: { appointmentId } });
    expect(rows).toHaveLength(1);
    // The rejected second attempt did not overwrite the first outcome.
    expect(rows[0].outcome).toBe('resolved');
  });

  it('refuses a second close through the /consultations address (same row)', async () => {
    const res = await request(app)
      .post('/consultations')
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ appointmentId, outcome: 'resolved', notes: 'Same appointment, other address.' });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(await prisma.consultation.count({ where: { appointmentId } })).toBe(1);
  });

  it('returns the decrypted notes to the treating doctor and the patient, and 403 to anyone else', async () => {
    const consultationId = (await prisma.consultation.findUniqueOrThrow({ where: { appointmentId } })).id;

    const asDoctor = await request(app)
      .get(`/consultations/${consultationId}`)
      .set('Authorization', `Bearer ${owningDoctorToken}`);
    expect(asDoctor.status).toBe(200);
    expect(asDoctor.body.notes).toBe('Reviewed results; no follow-up needed.');

    const asPatient = await request(app)
      .get(`/consultations/${consultationId}`)
      .set('Authorization', `Bearer ${patientToken}`);
    expect(asPatient.status).toBe(200);
    expect(asPatient.body.notes).toBe('Reviewed results; no follow-up needed.');

    const asOtherDoctor = await request(app)
      .get(`/consultations/${consultationId}`)
      .set('Authorization', `Bearer ${otherDoctorToken}`);
    expect(asOtherDoctor.status).toBe(403);
  });

  it('refuses a doctor who does not own the appointment (no existence leak)', async () => {
    const res = await request(app)
      .post(`/appointments/${appointmentId}/consultation`)
      .set('Authorization', `Bearer ${otherDoctorToken}`)
      .send({ outcome: 'resolved', notes: 'Not my appointment.' });

    expect(res.status).toBe(404);
  });

  it('refuses a patient closing a consultation (doctor-only route)', async () => {
    const res = await request(app)
      .post(`/appointments/${appointmentId}/consultation`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ outcome: 'resolved', notes: 'Patient attempt.' });

    expect(res.status).toBe(403);
  });

  it('rejects an unknown outcome', async () => {
    const res = await request(app)
      .post(`/appointments/${appointmentId}/consultation`)
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ outcome: 'cured', notes: 'Invalid outcome value.' });

    expect(res.status).toBe(400);
  });

  it('allows opening a consultation without an outcome and closing it later', async () => {
    const apptId = await makeCompletedAppointment();

    // 1. Open consultation with notes, without outcome
    const openRes = await request(app)
      .post('/consultations')
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ appointmentId: apptId, notes: 'Preliminary visit notes' });
    expect(openRes.status).toBe(201);
    expect(openRes.body.outcome).toBeNull();
    expect(openRes.body.notes).toBe('Preliminary visit notes');

    // Audit event for open consultation is not consultation.closed
    const auditBefore = await prisma.auditEvent.findMany({
      where: { entityType: 'Consultation', entityId: openRes.body.id, action: 'consultation.closed' },
    });
    expect(auditBefore).toHaveLength(0);

    // 2. Close it via POST /appointments/:id/consultation without new notes (notes preserved)
    const closeRes = await request(app)
      .post(`/appointments/${apptId}/consultation`)
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ outcome: 'resolved' });
    expect(closeRes.status, JSON.stringify(closeRes.body)).toBe(201);
    expect(closeRes.body.consultation.outcome).toBe('resolved');
    expect(closeRes.body.consultation.notes).toBe('Preliminary visit notes');

    // Audit event consultation.closed was created
    const auditAfter = await prisma.auditEvent.findMany({
      where: { entityType: 'Consultation', entityId: openRes.body.id, action: 'consultation.closed' },
    });
    expect(auditAfter).toHaveLength(1);
    expect(auditAfter[0].toState).toBe('resolved');

    // 3. Second close attempt fails 409
    const secondClose = await request(app)
      .post(`/appointments/${apptId}/consultation`)
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ outcome: 'follow_up_needed' });
    expect(secondClose.status).toBe(409);
  });

  it('handles race condition when two requests attempt to close the same open consultation concurrently', async () => {
    const apptId = await makeCompletedAppointment();

    const openRes = await request(app)
      .post('/consultations')
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ appointmentId: apptId, notes: 'Open for racing' });
    expect(openRes.status).toBe(201);

    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/appointments/${apptId}/consultation`)
        .set('Authorization', `Bearer ${owningDoctorToken}`)
        .send({ outcome: 'resolved' }),
      request(app)
        .post(`/appointments/${apptId}/consultation`)
        .set('Authorization', `Bearer ${owningDoctorToken}`)
        .send({ outcome: 'referred' }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);

    const rows = await prisma.consultation.findMany({ where: { appointmentId: apptId } });
    expect(rows).toHaveLength(1);
    expect(['resolved', 'referred']).toContain(rows[0].outcome);
  });

  it('refuses to let another doctor close an open consultation (404)', async () => {
    const apptId = await makeCompletedAppointment();

    const openRes = await request(app)
      .post('/consultations')
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ appointmentId: apptId, notes: 'Open notes' });
    expect(openRes.status).toBe(201);

    const otherClose = await request(app)
      .post(`/appointments/${apptId}/consultation`)
      .set('Authorization', `Bearer ${otherDoctorToken}`)
      .send({ outcome: 'resolved' });
    expect(otherClose.status).toBe(404);
  });

  it('lists consultations for the patient with pagination and no clinical notes', async () => {
    const res = await request(app)
      .get('/consultations/mine')
      .query({ limit: 1 })
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item).toMatchObject({
      id: expect.any(String),
      appointmentId: expect.any(String),
      date: expect.any(String),
      doctorName: 'Owning Doctor',
      createdAt: expect.any(String),
    });
    expect(item).not.toHaveProperty('notes');
    expect(JSON.stringify(res.body)).not.toContain('Preliminary visit notes');
    expect(JSON.stringify(res.body)).not.toContain('Reviewed results');
    expect(res.body.nextCursor).toBeTruthy();

    const nextRes = await request(app)
      .get('/consultations/mine')
      .query({ limit: 1, cursor: res.body.nextCursor })
      .set('Authorization', `Bearer ${patientToken}`);

    expect(nextRes.status).toBe(200);
    expect(nextRes.body.items).toHaveLength(1);
    expect(nextRes.body.items[0].id).not.toBe(item.id);
  });

  it('lists consultations for the treating doctor with pagination and displays anonymised patients', async () => {
    const docRes = await request(app)
      .get('/consultations/doctor')
      .query({ limit: 1 })
      .set('Authorization', `Bearer ${owningDoctorToken}`);

    expect(docRes.status).toBe(200);
    expect(docRes.body.items).toHaveLength(1);
    expect(docRes.body.items[0].patientName).toBe('Test Patient');
    expect(docRes.body.items[0]).not.toHaveProperty('notes');
    expect(docRes.body.nextCursor).toBeTruthy();

    // Test anonymised patient: create appointment, consultation, then anonymise profile
    const anonPatientToken = await signupAndVerify(
      app,
      'patient',
      `consult-anon-${runId}@example.com`,
      'Anon Patient',
    );
    const anonProfile = await prisma.patientProfile.findFirstOrThrow({
      where: { user: { email: `consult-anon-${runId}@example.com` } },
    });

    const slot = await prisma.availabilitySlot.create({
      data: {
        doctorProfileId,
        startTime: new Date(Date.now() - 7200_000),
        endTime: new Date(Date.now() - 5400_000),
        status: 'open',
      },
    });
    const book = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${anonPatientToken}`)
      .send({ availabilitySlotId: slot.id });
    expect(book.status).toBe(201);
    const anonApptId = book.body.id as string;

    await request(app)
      .patch(`/appointments/${anonApptId}/status`)
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ status: 'completed' });

    await request(app)
      .post(`/appointments/${anonApptId}/consultation`)
      .set('Authorization', `Bearer ${owningDoctorToken}`)
      .send({ outcome: 'resolved', notes: 'Secret visit notes for deleted patient' });

    // Anonymise the patient
    await prisma.patientProfile.update({
      where: { id: anonProfile.id },
      data: { anonymizedAt: new Date() },
    });

    const docList = await request(app)
      .get('/consultations/doctor')
      .query({ limit: 10 })
      .set('Authorization', `Bearer ${owningDoctorToken}`);

    expect(docList.status).toBe(200);
    const deletedEntry = docList.body.items.find((entry: { appointmentId: string }) => entry.appointmentId === anonApptId);
    expect(deletedEntry).toBeTruthy();
    expect(deletedEntry.patientName).toBe('Deleted patient');
    expect(deletedEntry).not.toHaveProperty('notes');
    expect(JSON.stringify(docList.body)).not.toContain('Secret visit notes');
  });

  it('enforces role and ownership scoping on list endpoints', async () => {
    const docAsPatient = await request(app)
      .get('/consultations/mine')
      .set('Authorization', `Bearer ${owningDoctorToken}`);
    expect(docAsPatient.status).toBe(403);

    const patientAsDoc = await request(app)
      .get('/consultations/doctor')
      .set('Authorization', `Bearer ${patientToken}`);
    expect(patientAsDoc.status).toBe(403);

    const otherDoctorList = await request(app)
      .get('/consultations/doctor')
      .set('Authorization', `Bearer ${otherDoctorToken}`);
    expect(otherDoctorList.status).toBe(200);
    expect(otherDoctorList.body.items).toHaveLength(0);
  });
});
