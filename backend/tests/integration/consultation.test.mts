// Integration tests for issue #4: closing a consultation, exactly once.
// (ROADMAP.md Phase 2 — "`Consultation` record + outcome".)
//
// The correctness-critical assertions here are:
//   1. the owning doctor can close their appointment's consultation once;
//   2. a second close is refused AND the database still holds exactly one
//      row — the unique constraint on Consultation.appointmentId is the
//      guarantee, not the service's pre-check;
//   3. another doctor cannot close it (404, not 403 — no existence leak).
//
// Self-contained like the other integration suites: spins up its own
// throwaway Postgres (embedded-postgres, prebuilt binary) on port 5436 and
// applies the committed migrations, so no pre-existing DB/Docker is needed.
// A distinct port keeps it clear of booking.test.mts (5433), the payments
// testnet suite (5435) and access-control.test.mts (5438).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5436;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-consult-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

// Matches vitest.config.mts's DATABASE_URL convention: the client built at
// import time in src/db/prisma-client.ts connects lazily with this URL.
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

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
  let appointmentId: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
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
    const doctorProfileId = doctorMe.body.id as string;

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
  });

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
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
});
