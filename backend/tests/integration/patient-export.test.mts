// Integration tests for patient data export (Phase 8, issue #40 — right of
// access): owner-only access, the job lifecycle, the bundle contents
// (sections from each module's service, tx hashes, no secrets), bounded
// streaming, failure handling, stale-claim recovery, and expiry/cleanup.
// Self-contained, same embedded-Postgres pattern as booking.test.mts — see
// that file's header for why. Own port (5442) so it runs alongside the
// other integration files.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import EmbeddedPostgres from 'embedded-postgres';
import { createOrderFixture, createPaymentIntentForFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5442;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-export-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

// Sentinel platform secrets: the bundle must never contain them.
const PAYER_SECRET = `SPAYERSENTINEL${runId}`;
const RELEASER_SECRET = `SRELEASERSENTINEL${runId}`;
// Small pages and chunks so a modest fixture exercises multi-page,
// multi-chunk streaming.
const PAGE_SIZE = 7;
const CHUNK_BYTES = 1024;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;
type PatientsService = typeof import('../../src/modules/patients/services/index.js');

const emailedTokens = new Map<string, string>();

describe('patient data export', () => {
  let app: App;
  let prisma: Prisma;
  let patients: PatientsService;

  let doctorToken: string;
  let doctorProfileId: string;
  let adminToken: string;
  let alice: { token: string; userId: string; profileId: string; email: string };
  let bob: { token: string; userId: string; profileId: string; email: string };
  let facilityId: string;
  let aliceLabOrder: Awaited<ReturnType<typeof createOrderFixture>>;
  let alicePrescription: Awaited<ReturnType<typeof createOrderFixture>>;

  async function signupVerified(role: 'patient' | 'doctor', label: string) {
    const email = `${label}-${runId}@example.com`;
    const res = await request(app)
      .post('/auth/signup')
      .send({ role, email, password: 'longenough123', fullName: `${label} Fullname` });
    expect(res.status).toBe(200);
    const verified = await request(app).post('/auth/verify-email').send({ token: emailedTokens.get(email) });
    expect(verified.status).toBe(200);
    return { token: res.body.accessToken as string, userId: res.body.user.id as string, email };
  }

  async function signupPatient(label: string) {
    const user = await signupVerified('patient', label);
    const profile = await prisma.patientProfile.findUniqueOrThrow({ where: { userId: user.userId } });
    return { ...user, profileId: profile.id };
  }

  async function download(token: string, exportId: string) {
    return request(app)
      .get(`/patients/me/export/${exportId}/download`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res, callback) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => callback(null, data));
      });
  }

  async function requestAndGenerate(token: string) {
    const created = await request(app).post('/patients/me/export').set('Authorization', `Bearer ${token}`);
    expect(created.status).toBe(202);
    expect(await patients.processExport(created.body.id)).toBe('ready');
    return created.body.id as string;
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

    // Must be set before the app module (config, PrismaClient) loads.
    process.env.DATABASE_URL = databaseUrl;
    process.env.PATIENT_EXPORT_PAGE_SIZE = String(PAGE_SIZE);
    process.env.PATIENT_EXPORT_CHUNK_BYTES = String(CHUNK_BYTES);
    process.env.PATIENT_EXPORT_TTL_HOURS = '24';
    process.env.PLATFORM_PAYER_SECRET = PAYER_SECRET;
    process.env.PLATFORM_RELEASER_SECRET = RELEASER_SECRET;

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    patients = await import('../../src/modules/patients/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    authServices.setEmailSender(async (message) => {
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
    });

    const doctor = await signupVerified('doctor', 'export-doctor');
    doctorToken = doctor.token;
    doctorProfileId = (await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doctor.userId } })).id;

    const admin = await prisma.user.create({
      data: { email: `admin-${runId}@example.com`, passwordHash: 'x', role: 'admin', emailVerifiedAt: new Date() },
    });
    adminToken = jwt.sign({ sub: admin.id, role: 'admin' }, 'test-access-secret', { expiresIn: '15m' });

    alice = await signupPatient('alice');
    bob = await signupPatient('bob');

    // Alice books one appointment through the real booking endpoint...
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const generate = await request(app)
      .post(`/availability/doctors/${doctorProfileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ date: tomorrow, startHour: 9, endHour: 10, slotLengthMinutes: 30 });
    expect(generate.status).toBe(201);
    const slots = await request(app).get(`/availability/doctors/${doctorProfileId}/slots`);
    const booked = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ availabilitySlotId: slots.body[0].id });
    expect(booked.status).toBe(201);

    // ...plus enough history to span several pages and chunks.
    const base = Date.now() + 2 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 20; i += 1) {
      const slot = await prisma.availabilitySlot.create({
        data: {
          doctorProfileId,
          status: 'booked',
          startTime: new Date(base + i * 30 * 60 * 1000),
          endTime: new Date(base + (i + 1) * 30 * 60 * 1000),
        },
      });
      await prisma.appointment.create({
        data: { patientProfileId: alice.profileId, doctorProfileId, availabilitySlotId: slot.id },
      });
    }

    const facilityUser = await prisma.user.create({
      data: { email: `lab-${runId}@example.com`, passwordHash: 'x', role: 'facility' },
    });
    facilityId = (
      await prisma.facilityProfile.create({ data: { userId: facilityUser.id, name: 'Lagos Lab', type: 'lab' } })
    ).id;
    aliceLabOrder = await createOrderFixture(prisma, { patientProfileId: alice.profileId, facilityProfileId: facilityId, kind: 'lab_order', amountStroops: 12_345_678_901n, tag: `alice-lab-${runId}` });
    const aliceLabPayment = await createPaymentIntentForFixture(prisma, aliceLabOrder, 'escrowed');
    await prisma.paymentIntent.update({ where: { id: aliceLabPayment.id }, data: { escrowId: 42n, stellarTxHash: 'a'.repeat(64), sorobanContractId: 'CCONTRACT' } });
    alicePrescription = await createOrderFixture(prisma, { patientProfileId: alice.profileId, facilityProfileId: facilityId, kind: 'prescription', amountStroops: 5n, tag: `alice-rx-${runId}` });
    await createPaymentIntentForFixture(prisma, alicePrescription);
    const bobPrescription = await createOrderFixture(prisma, { patientProfileId: bob.profileId, facilityProfileId: facilityId, kind: 'prescription', amountStroops: 9n, tag: `bob-rx-${runId}` });
    await prisma.paymentIntent.create({ data: {
      prescriptionId: bobPrescription.id, patientProfileId: bob.profileId, facilityId,
      amount: 9n, assetCode: 'XLM', stellarTxHash: 'b'.repeat(64),
    } });
  }, 180_000);

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lets a patient request an export, deduplicating while one is in flight', async () => {
    const [first, second] = await Promise.all([
      request(app).post('/patients/me/export').set('Authorization', `Bearer ${bob.token}`),
      request(app).post('/patients/me/export').set('Authorization', `Bearer ${bob.token}`),
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.body.id).toBe(second.body.id);
    expect(first.body.status).toBe('pending');
    expect(first.body.downloadUrl).toBeNull();
    expect(first.headers.location).toBe(`/patients/me/export/${first.body.id}`);
    expect(await prisma.patientExport.count({ where: { patientProfileId: bob.profileId } })).toBe(1);

    const status = await request(app)
      .get(`/patients/me/export/${first.body.id}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('pending');

    // Download before it's ready is a 409, not a partial file.
    const early = await download(bob.token, first.body.id);
    expect(early.status).toBe(409);
    expect(early.body).toContain('EXPORT_NOT_READY');

    expect(await patients.processExport(first.body.id)).toBe('ready');
    // Once it's no longer in flight, a new request starts a new job.
    const next = await request(app).post('/patients/me/export').set('Authorization', `Bearer ${bob.token}`);
    expect(next.body.id).not.toBe(first.body.id);
    await patients.processExport(next.body.id);
  });

  it('refuses doctors, admins and anonymous callers on every export route', async () => {
    const exportId = (await prisma.patientExport.findFirstOrThrow({ where: { patientProfileId: bob.profileId } })).id;
    for (const token of [doctorToken, adminToken]) {
      const auth = { Authorization: `Bearer ${token}` };
      expect((await request(app).post('/patients/me/export').set(auth)).status).toBe(403);
      expect((await request(app).get(`/patients/me/export/${exportId}`).set(auth)).status).toBe(403);
      expect((await request(app).get(`/patients/me/export/${exportId}/download`).set(auth)).status).toBe(403);
    }
    expect((await request(app).post('/patients/me/export')).status).toBe(401);
    expect((await request(app).get(`/patients/me/export/${exportId}`)).status).toBe(401);
    // And no patient-id parameter is honoured anywhere: a body naming Bob
    // still exports the caller (or nobody, for non-patients).
    const sneaky = await request(app)
      .post('/patients/me/export')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ patientProfileId: bob.profileId });
    const row = await prisma.patientExport.findUniqueOrThrow({ where: { id: sneaky.body.id } });
    expect(row.patientProfileId).toBe(alice.profileId);
    await patients.processExport(row.id);
  });

  it("returns 404 for another patient's export id, on status and download", async () => {
    const bobsExport = await prisma.patientExport.findFirstOrThrow({
      where: { patientProfileId: bob.profileId, status: 'ready' },
    });
    const status = await request(app)
      .get(`/patients/me/export/${bobsExport.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(status.status).toBe(404);
    expect((await download(alice.token, bobsExport.id)).status).toBe(404);
    // ...while Bob can download it.
    expect((await download(bob.token, bobsExport.id)).status).toBe(200);
  });

  it('builds a complete, versioned bundle from each module and leaks no secrets', async () => {
    const exportId = await requestAndGenerate(alice.token);
    const status = await request(app).get(`/patients/me/export/${exportId}`).set('Authorization', `Bearer ${alice.token}`);
    expect(status.body).toMatchObject({ status: 'ready', schemaVersion: 1, failure: null });
    expect(status.body.downloadUrl).toBe(`/patients/me/export/${exportId}/download`);
    expect(new Date(status.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);

    const res = await download(alice.token, exportId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toContain(`docforum-export-${exportId}.json`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.body));

    const bundle = JSON.parse(res.body);
    expect(bundle.format).toBe('docforum.patient-export');
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.exportId).toBe(exportId);
    expect(new Date(bundle.generatedAt).toISOString()).toBe(bundle.generatedAt);
    expect(Object.keys(bundle.sections)).toEqual(['account', 'appointments', 'lab_orders', 'payments', 'prescriptions', 'profile']);

    expect(bundle.sections.account.items).toEqual([
      expect.objectContaining({ id: alice.userId, email: alice.email, role: 'patient' }),
    ]);
    expect(bundle.sections.profile.items).toEqual([
      expect.objectContaining({ id: alice.profileId, fullName: 'alice Fullname' }),
    ]);

    const appointments = bundle.sections.appointments.items;
    expect(appointments).toHaveLength(23);
    expect(new Set(appointments.map((a: { id: string }) => a.id)).size).toBe(23);
    expect(appointments.filter((appointment: { doctor: { id: string; fullName: string } }) => appointment.doctor.id === doctorProfileId)).toHaveLength(21);
    expect(appointments.filter((appointment: { doctor: { fullName: string } }) => appointment.doctor.fullName === 'Order Test Doctor')).toHaveLength(2);
    for (const appointment of appointments) {
      expect(appointment.slot.startTime).toBeTruthy();
      expect(appointment.status).toBe('scheduled');
    }

    const payments = bundle.sections.payments.items;
    expect(payments).toHaveLength(2);
    expect(payments[0]).toMatchObject({
      labOrderId: aliceLabOrder.id,
      status: 'escrowed',
      amount: '12345678901',
      assetCode: 'XLM',
      escrowId: '42',
      stellarTxHash: 'a'.repeat(64),
      sorobanContractId: 'CCONTRACT',
      facility: { id: facilityId, name: 'Lagos Lab' },
    });
    expect(payments[1]).toMatchObject({ prescriptionId: alicePrescription.id, stellarTxHash: null, escrowId: null });

    // Nothing that isn't Alice's, and nothing operational or secret.
    const passwordHash = (await prisma.user.findUniqueOrThrow({ where: { id: alice.userId } })).passwordHash;
    expect(res.body).not.toContain('b'.repeat(64));
    expect(res.body).not.toContain('bob-order');
    expect(res.body).not.toContain(PAYER_SECRET);
    expect(res.body).not.toContain(RELEASER_SECRET);
    expect(res.body).not.toContain(passwordHash);
    expect(res.body).not.toMatch(/passwordHash|tokenHash|csrf|LoginAttempt/i);
  });

  it('streams large histories in bounded chunks', async () => {
    const exportId = await requestAndGenerate(alice.token);
    const record = await prisma.patientExport.findUniqueOrThrow({ where: { id: exportId } });
    const chunks = await prisma.patientExportChunk.findMany({ where: { exportId }, orderBy: { seq: 'asc' } });
    expect(record.chunkCount).toBe(chunks.length);
    expect(chunks.length).toBeGreaterThan(3);
    // Every chunk is at most the limit plus one serialized appointment.
    for (const chunk of chunks) expect(Buffer.byteLength(chunk.data)).toBeLessThan(CHUNK_BYTES + 600);
    expect(chunks.reduce((sum, c) => sum + Buffer.byteLength(c.data), 0)).toBe(record.sizeBytes);

    // Sections are paged: storage already holds output by the time a later
    // page is requested.
    const seenAtPage: number[] = [];
    const probe = {
      name: 'zz_probe',
      version: 1,
      async *pages() {
        for (let page = 0; page < 4; page += 1) {
          seenAtPage.push(await prisma.patientExportChunk.count({ where: { exportId: probeExportId } }));
          yield Array.from({ length: PAGE_SIZE }, (_, i) => ({ page, i, pad: 'p'.repeat(100) }));
        }
      },
    };
    const probeRequest = await request(app).post('/patients/me/export').set('Authorization', `Bearer ${alice.token}`);
    const probeExportId = probeRequest.body.id as string;
    expect(await patients.processExport(probeExportId, [...patients.listExportSections(), probe])).toBe('ready');
    expect(seenAtPage[0]).toBeGreaterThan(0);
    expect(seenAtPage[3]).toBeGreaterThan(seenAtPage[0]);
  });

  it('runs each job exactly once even when two workers race for it', async () => {
    const created = await request(app).post('/patients/me/export').set('Authorization', `Bearer ${alice.token}`);
    const results = await Promise.all([patients.processExport(created.body.id), patients.processExport(created.body.id)]);
    expect(results.filter((r) => r === 'ready')).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    const record = await prisma.patientExport.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(record.attempt).toBe(1);
  });

  it('marks the job failed, keeps no partial artifact and stores no error text when a section fails', async () => {
    const failing = {
      name: 'zz_failing',
      version: 1,
      async *pages() {
        yield [{ partial: true }];
        throw new Error('could not read record of alice Fullname');
      },
    };
    patients.registerExportSection(failing);
    try {
      const created = await request(app).post('/patients/me/export').set('Authorization', `Bearer ${alice.token}`);
      expect(await patients.processExport(created.body.id)).toBe('failed');

      const record = await prisma.patientExport.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(record).toMatchObject({ status: 'failed', failureCode: 'SECTION_FAILED', failedSection: 'zz_failing' });
      expect(record.expiresAt).toBeNull();
      expect(JSON.stringify(record)).not.toContain('alice Fullname');
      expect(await prisma.patientExportChunk.count({ where: { exportId: created.body.id } })).toBe(0);

      const status = await request(app)
        .get(`/patients/me/export/${created.body.id}`)
        .set('Authorization', `Bearer ${alice.token}`);
      expect(status.body).toMatchObject({
        status: 'failed',
        downloadUrl: null,
        failure: { code: 'SECTION_FAILED', section: 'zz_failing' },
      });
      expect((await download(alice.token, created.body.id)).status).toBe(409);
    } finally {
      patients.unregisterExportSection('zz_failing');
    }
  });

  it('requeues a dead claim, fences the stale attempt, and fails after max attempts', async () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    const stale = await prisma.patientExport.create({
      data: { patientProfileId: bob.profileId, status: 'processing', attempt: 1, startedAt: longAgo },
    });
    await prisma.patientExportChunk.create({ data: { exportId: stale.id, attempt: 1, seq: 0, data: '{"half":' } });
    const exhausted = await prisma.patientExport.create({
      data: { patientProfileId: bob.profileId, status: 'processing', attempt: 3, startedAt: longAgo },
    });

    const recovered = await patients.recoverStaleExports();
    expect(recovered).toEqual({ requeued: 1, failed: 1 });
    expect((await prisma.patientExport.findUniqueOrThrow({ where: { id: exhausted.id } })).failureCode).toBe(
      'GENERATION_TIMEOUT',
    );

    expect(await patients.processExport(stale.id)).toBe('ready');
    const record = await prisma.patientExport.findUniqueOrThrow({ where: { id: stale.id } });
    expect(record.attempt).toBe(2);
    // The dead attempt's half-written chunk is never served, and cleanup
    // removes it.
    const res = await download(bob.token, stale.id);
    expect(() => JSON.parse(res.body)).not.toThrow();
    await patients.expireExports();
    expect(await prisma.patientExportChunk.count({ where: { exportId: stale.id, attempt: 1 } })).toBe(0);
    expect(await prisma.patientExportChunk.count({ where: { exportId: stale.id, attempt: 2 } })).toBe(record.chunkCount);
  });

  it('refuses downloads at expiry, then cleanup deletes only expired artifacts', async () => {
    const aliceExport = await requestAndGenerate(alice.token);
    const bobExport = await requestAndGenerate(bob.token);
    const bobChunks = await prisma.patientExportChunk.count({ where: { exportId: bobExport } });
    expect(bobChunks).toBeGreaterThan(0);

    // Past its deadline but not yet cleaned up: already refused.
    await prisma.patientExport.update({ where: { id: aliceExport }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const refused = await download(alice.token, aliceExport);
    expect(refused.status).toBe(410);
    expect(refused.body).toContain('EXPORT_EXPIRED');
    const status = await request(app).get(`/patients/me/export/${aliceExport}`).set('Authorization', `Bearer ${alice.token}`);
    expect(status.body).toMatchObject({ status: 'expired', downloadUrl: null, sizeBytes: null });

    const result = await patients.expireExports();
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect((await prisma.patientExport.findUniqueOrThrow({ where: { id: aliceExport } })).status).toBe('expired');
    expect(await prisma.patientExportChunk.count({ where: { exportId: aliceExport } })).toBe(0);
    // Bob's still-valid export is untouched.
    expect(await prisma.patientExportChunk.count({ where: { exportId: bobExport } })).toBe(bobChunks);
    expect((await download(bob.token, bobExport)).status).toBe(200);

    // Simulating the clock past every TTL expires everything still ready.
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await patients.expireExports(later);
    expect(await prisma.patientExport.count({ where: { status: 'ready' } })).toBe(0);
    expect(await prisma.patientExportChunk.count()).toBe(0);
    expect((await download(bob.token, bobExport)).status).toBe(410);
    // Running it again is a no-op.
    expect(await patients.expireExports(later)).toEqual({ expired: 0, orphanChunksDeleted: 0 });
  });

  it('generates through the real job wiring: a request wakes the worker without a manual call', async () => {
    const jobs = await import('../../src/jobs/patient-exports.js');
    const stop = jobs.startPatientExportJobs();
    try {
      const created = await request(app).post('/patients/me/export').set('Authorization', `Bearer ${bob.token}`);
      expect(created.status).toBe(202);
      let status = created.body.status as string;
      for (let i = 0; i < 50 && status !== 'ready'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const res = await request(app).get(`/patients/me/export/${created.body.id}`).set('Authorization', `Bearer ${bob.token}`);
        status = res.body.status;
      }
      expect(status).toBe('ready');
    } finally {
      stop();
    }
  });

  it('leaves booking intact: booked appointments and slots are unchanged by exporting', async () => {
    const before = await prisma.appointment.count({ where: { patientProfileId: alice.profileId } });
    await requestAndGenerate(alice.token);
    expect(await prisma.appointment.count({ where: { patientProfileId: alice.profileId } })).toBe(before);
    expect(await prisma.availabilitySlot.count({ where: { doctorProfileId, status: 'open' } })).toBe(1);
  });
});
