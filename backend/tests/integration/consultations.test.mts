// Consultation sign-off + append-only addenda (Phase 2 #64) — integration,
// against a real Postgres, because the point of this issue is a DB-level
// guarantee: an UPDATE on a signed-off note must fail even when it bypasses
// the repository entirely. A mock can't demonstrate that.
//
// Self-contained like the other integration suites: throwaway Postgres on
// port 5448 (one port per file — vitest runs files in parallel).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5448;
const runId = Date.now();

// Set before importing anything from src/ — config/index.ts reads process.env
// at module load, and a 1-hour window keeps the auto-sign-off test deterministic.
process.env.DATABASE_URL = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
process.env.CONSULTATION_AUTO_SIGNOFF_HOURS = '1';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-consultations-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;

describe('consultation sign-off', () => {
  let app: App;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let autoSignOffDueConsultations: typeof import('../../src/modules/consultations/services/index.js').autoSignOffDueConsultations;

  let authorToken: string;
  let otherDoctorToken: string;
  let consultationId: string;
  // A consultation closes exactly one appointment (unique FK), so each test
  // that creates a note gets its own seeded appointment.
  let appointmentIds: string[] = [];

  function create(token: string, body: Record<string, unknown> = {}) {
    const appointmentId = appointmentIds.shift();
    if (!appointmentId) throw new Error('no seeded appointment left for this test');
    return request(app)
      .post('/consultations')
      .set('Authorization', `Bearer ${token}`)
      .send({ appointmentId, ...body });
  }

  function get(token: string, id = consultationId) {
    return request(app).get(`/consultations/${id}`).set('Authorization', `Bearer ${token}`);
  }

  function patch(token: string, body: Record<string, unknown>, id = consultationId) {
    return request(app).patch(`/consultations/${id}`).set('Authorization', `Bearer ${token}`).send(body);
  }

  function signOff(token: string, id = consultationId) {
    return request(app).post(`/consultations/${id}/sign-off`).set('Authorization', `Bearer ${token}`);
  }

  function addAddendum(token: string, body: string, id = consultationId) {
    return request(app).post(`/consultations/${id}/addenda`).set('Authorization', `Bearer ${token}`).send({ body });
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    const [appModule, dbModule, consultationsModule] = await Promise.all([
      import('../../src/app.js'),
      import('../../src/db/prisma-client.js'),
      import('../../src/modules/consultations/services/index.js'),
    ]);
    app = appModule.createApp();
    prisma = dbModule.prisma;
    autoSignOffDueConsultations = consultationsModule.autoSignOffDueConsultations;

    const author = await request(app)
      .post('/auth/signup')
      .send({ role: 'doctor', email: `consult-author-${runId}@example.com`, password: 'doctor-pass-1', fullName: 'Author Doctor' });
    expect(author.status).toBe(200);
    authorToken = author.body.accessToken as string;

    const other = await request(app)
      .post('/auth/signup')
      .send({ role: 'doctor', email: `consult-other-${runId}@example.com`, password: 'doctor-pass-2', fullName: 'Other Doctor' });
    expect(other.status).toBe(200);
    otherDoctorToken = other.body.accessToken as string;

    // A consultation is written against a doctor-owned appointment, and the
    // appointments service requires a verified doctor, so verify the author
    // and seed a patient + three booked appointments directly.
    const patient = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email: `consult-patient-${runId}@example.com`, password: 'patient-pass-1', fullName: 'Consult Patient' });
    expect(patient.status).toBe(200);

    const patientProfile = await prisma.patientProfile.findUniqueOrThrow({
      where: { userId: (await prisma.user.findUniqueOrThrow({ where: { email: `consult-patient-${runId}@example.com` } })).id },
    });
    const authorUser = await prisma.user.findUniqueOrThrow({ where: { email: `consult-author-${runId}@example.com` } });
    const authorProfile = await prisma.doctorProfile.update({
      where: { userId: authorUser.id },
      data: { verificationStatus: 'verified' },
    });

    for (let index = 0; index < 3; index += 1) {
      const startTime = new Date(Date.now() + (index + 1) * 60 * 60 * 1000);
      const slot = await prisma.availabilitySlot.create({
        data: {
          doctorProfileId: authorProfile.id,
          status: 'booked',
          startTime,
          endTime: new Date(startTime.getTime() + 30 * 60 * 1000),
        },
      });
      const appointment = await prisma.appointment.create({
        data: {
          patientProfileId: patientProfile.id,
          doctorProfileId: authorProfile.id,
          availabilitySlotId: slot.id,
          // A consultation is recorded once the visit is over.
          status: 'completed',
        },
      });
      appointmentIds.push(appointment.id);
    }

    const created = await create(authorToken, { notes: 'Initial assessment', outcome: 'follow_up_needed' });
    expect(created.status).toBe(201);
    consultationId = created.body.id as string;
    expect(created.body.signedAt).toBeNull();
    expect(created.body.editable).toBe(true);
    expect(created.body.addenda).toEqual([]);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lets the authoring doctor edit the note while it is a draft', async () => {
    const updated = await patch(authorToken, { notes: 'Revised assessment' });
    expect(updated.status).toBe(200);
    expect(updated.body.notes).toBe('Revised assessment');
    expect(updated.body.editable).toBe(true);
  });

  it('rejects an empty PATCH body', async () => {
    expect((await patch(authorToken, {})).status).toBe(400);
  });

  it('hides a consultation from another doctor', async () => {
    expect((await get(otherDoctorToken)).status).toBe(404);
    expect((await signOff(otherDoctorToken)).status).toBe(404);
    expect((await addAddendum(otherDoctorToken, 'not mine')).status).toBe(404);
    // ...and the note is untouched by those attempts.
    const own = await get(authorToken);
    expect(own.body.signedAt).toBeNull();
    expect(own.body.addenda).toEqual([]);
  });

  it('refuses addenda before sign-off — the note itself is still editable', async () => {
    const early = await addAddendum(authorToken, 'premature addendum');
    expect(early.status).toBe(409);
  });

  it('signs off the note', async () => {
    const signed = await signOff(authorToken);
    expect(signed.status).toBe(200);
    expect(signed.body.signedAt).toBeTruthy();
    expect(signed.body.editable).toBe(false);
  });

  it('refuses a second sign-off', async () => {
    expect((await signOff(authorToken)).status).toBe(409);
  });

  it('refuses to edit a signed-off note through the API', async () => {
    const edit = await patch(authorToken, { notes: 'tampered after sign-off' });
    expect(edit.status).toBe(409);

    const read = await get(authorToken);
    expect(read.body.notes).toBe('Revised assessment');
  });

  it('rejects a direct UPDATE of a signed-off note at the DB level', async () => {
    // The reviewer's test: bypass the repository entirely.
    await expect(
      prisma.consultation.update({ where: { id: consultationId }, data: { notes: 'bypassed the service' } }),
    ).rejects.toThrow(/immutable/i);

    await expect(
      prisma.consultation.update({ where: { id: consultationId }, data: { outcome: 'resolved' } }),
    ).rejects.toThrow(/immutable/i);

    // Un-signing would make the note mutable again, so it's rejected too.
    await expect(
      prisma.consultation.update({ where: { id: consultationId }, data: { signedAt: null } }),
    ).rejects.toThrow(/immutable/i);

    const row = await prisma.consultation.findUniqueOrThrow({ where: { id: consultationId } });
    expect(row.notes).toBe('Revised assessment');
    expect(row.outcome).toBe('follow_up_needed');
    expect(row.signedAt).not.toBeNull();
  });

  it('allows addenda after sign-off, in order, and still blocks the author rule', async () => {
    const first = await addAddendum(authorToken, 'First correction');
    expect(first.status).toBe(201);
    const second = await addAddendum(authorToken, 'Second correction');
    expect(second.status).toBe(201);

    expect((await addAddendum(otherDoctorToken, 'not mine either')).status).toBe(404);

    const read = await get(authorToken);
    expect(read.body.addenda.map((a: { body: string }) => a.body)).toEqual(['First correction', 'Second correction']);
    // The note itself is unchanged by addenda.
    expect(read.body.notes).toBe('Revised assessment');
    expect(read.body.editable).toBe(false);
  });

  it('auto-signs off a draft past the edit window', async () => {
    const created = await create(authorToken, { notes: 'Left open too long' });
    expect(created.status).toBe(201);
    const staleId = created.body.id as string;

    // Backdate it past the 1-hour window configured for this run. `createdAt`
    // is not part of the immutability trigger (only notes/outcome/signedAt),
    // so this is an allowed write on a draft.
    await prisma.consultation.update({
      where: { id: staleId },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    const signedOff = await autoSignOffDueConsultations();
    expect(signedOff).toBeGreaterThanOrEqual(1);

    const row = await prisma.consultation.findUniqueOrThrow({ where: { id: staleId } });
    expect(row.signedAt).not.toBeNull();

    // And it's genuinely immutable now, not just marked.
    expect((await patch(authorToken, { notes: 'too late' }, staleId)).status).toBe(409);
    await expect(
      prisma.consultation.update({ where: { id: staleId }, data: { notes: 'too late directly' } }),
    ).rejects.toThrow(/immutable/i);
  });

  it('leaves a fresh draft alone when the auto-sign-off job runs', async () => {
    const created = await create(authorToken, { notes: 'Still fresh' });
    const freshId = created.body.id as string;

    await autoSignOffDueConsultations();

    const row = await prisma.consultation.findUniqueOrThrow({ where: { id: freshId } });
    expect(row.signedAt).toBeNull();
    expect((await patch(authorToken, { notes: 'edited while drafted' }, freshId)).status).toBe(200);
  });
});
