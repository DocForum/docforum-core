// Integration tests for issue #69: the controlled medication vocabulary and
// structured prescription items (ROADMAP.md Phase 4, PRD FR-10).
//
// What this file proves, over HTTP against a real Postgres:
//   1. `GET /medications?q=` autocompletes the catalog (authenticated, with a
//      minimum query length and a bounded page size);
//   2. issuing a prescription from a catalog row links `medicationId` and
//      snapshots that row's display name onto the item;
//   3. editing the catalog afterwards does NOT change the already-issued
//      prescription — the snapshot is the item's own data (hard rule 1);
//   4. the explicit "unlisted medication" path is accepted with free text and
//      flagged for pharmacist review, while an unknown `medicationId` is a
//      400 that writes nothing;
//   5. search stays fast with tens of thousands of catalog rows, against the
//      trigram index created by the `medication_catalog` migration.
//
// Self-contained like the other integration suites: its own embedded
// Postgres on its own port (5472) with the committed migrations applied.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5472;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-medications-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
// Must be set before src/db/prisma-client.ts builds the client at import time.
process.env.DATABASE_URL = databaseUrl;

const emailedTokens = new Map<string, string>();

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

const PASSWORD = 'longenough123';

describe('issue #69: medication catalog and structured prescription items', () => {
  let app: App;
  let prisma: Prisma;

  let doctorToken: string;
  let doctorProfileId: string;
  let patientToken: string;
  let pharmacyId: string;

  /** One consultation on a completed appointment, reused by every issuance
   * test: each test issues a *new* prescription, and the append-only model
   * allows many per consultation. */
  let consultationId: string;

  let amoxicillinId: string;
  let snapshotMedicationId: string;

  const prescriptionsUrl = () => `/orders/consultations/${consultationId}/prescriptions`;
  const body = (items: unknown[]) => ({ facilityProfileId: pharmacyId, amountStroops: '1500000', items });

  async function signup(role: 'doctor' | 'patient', email: string) {
    const res = await request(app).post('/auth/signup').send({ role, email, password: PASSWORD, fullName: `Med69 ${role}` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const token = emailedTokens.get(email);
    expect(token, `no verification email captured for ${email}`).toBeTruthy();
    const verified = await request(app).post('/auth/verify-email').send({ token });
    expect(verified.status).toBe(200);
    return { token: res.body.accessToken as string, userId: res.body.user.id as string };
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

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;
    authServices.setEmailSender(async (message) => {
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
    });

    const doctor = await signup('doctor', `med69-doctor-${runId}@example.com`);
    const patient = await signup('patient', `med69-patient-${runId}@example.com`);
    doctorToken = doctor.token;
    patientToken = patient.token;
    await prisma.doctorProfile.updateMany({ where: { userId: doctor.userId }, data: { verificationStatus: 'verified' } });
    doctorProfileId = (await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doctor.userId } })).id;

    const bcryptjs = await import('bcryptjs');
    const facilityUser = await prisma.user.create({
      data: { email: `med69-pharmacy-${runId}@example.com`, passwordHash: await bcryptjs.hash(PASSWORD, 4), role: 'facility', emailVerifiedAt: new Date() },
    });
    pharmacyId = (await prisma.facilityProfile.create({ data: { userId: facilityUser.id, name: `Pharmacy ${runId}`, type: 'pharmacy' } })).id;

    // A completed appointment + consultation, the state the issuance path needs.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const generate = await request(app)
      .post(`/availability/doctors/${doctorProfileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ date: tomorrow, startHour: 9, endHour: 10, slotLengthMinutes: 30 });
    expect(generate.status, JSON.stringify(generate.body)).toBe(201);
    const slots = await request(app).get(`/availability/doctors/${doctorProfileId}/slots`);
    const book = await request(app).post('/appointments').set('Authorization', `Bearer ${patientToken}`).send({ availabilitySlotId: slots.body[0].id });
    expect(book.status, JSON.stringify(book.body)).toBe(201);
    await prisma.availabilitySlot.update({
      where: { id: slots.body[0].id },
      data: { startTime: new Date(Date.now() - 60000) },
    });
    const done = await request(app)
      .patch(`/appointments/${book.body.id}/status`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ status: 'completed' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const consultation = await request(app)
      .post('/consultations')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ appointmentId: book.body.id });
    expect(consultation.status, JSON.stringify(consultation.body)).toBe(201);
    consultationId = consultation.body.id;

    const amoxicillin = await prisma.medication.create({
      data: { genericName: 'Amoxicillin', strength: '500 mg', form: 'capsule', route: 'oral', externalCode: `NDC-${runId}-AMOX` },
    });
    amoxicillinId = amoxicillin.id;
    const snapshot = await prisma.medication.create({
      data: { genericName: 'Snapshotmycin', strength: '250 mg', form: 'tablet', route: 'oral', externalCode: `NDC-${runId}-SNAP` },
    });
    snapshotMedicationId = snapshot.id;
  });

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('GET /medications?q=', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/medications?q=amox');
      expect(res.status).toBe(401);
    });

    it('autocompletes by generic name and returns the exact variant fields', async () => {
      const res = await request(app).get('/medications?q=amox').set('Authorization', `Bearer ${doctorToken}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(Array.isArray(res.body.medications)).toBe(true);
      const hit = res.body.medications.find((medication: { id: string }) => medication.id === amoxicillinId);
      expect(hit).toBeTruthy();
      expect(hit).toMatchObject({
        genericName: 'Amoxicillin',
        strength: '500 mg',
        form: 'capsule',
        route: 'oral',
        // The exact string an issued item snapshots.
        displayName: 'Amoxicillin 500 mg capsule',
      });
    });

    it('rejects a query shorter than 2 characters and caps the page size', async () => {
      const short = await request(app).get('/medications?q=a').set('Authorization', `Bearer ${doctorToken}`);
      expect(short.status).toBe(400);

      const tooMany = await request(app).get('/medications?q=amox&limit=500').set('Authorization', `Bearer ${doctorToken}`);
      expect(tooMany.status).toBe(400);

      const one = await request(app).get('/medications?q=amox&limit=1').set('Authorization', `Bearer ${doctorToken}`);
      expect(one.status).toBe(200);
      expect(one.body.medications).toHaveLength(1);
    });

    it('is fast with tens of thousands of catalog rows (trigram index)', async () => {
      const existing = await prisma.medication.count();
      if (existing < 20_000) {
        const rows = Array.from({ length: 30_000 }, (_value, index) => ({
          genericName: `Zzbench Molecule ${index}`,
          strength: `${index % 900 + 1} mg`,
          form: 'tablet',
          route: 'oral',
          externalCode: null,
        }));
        for (let start = 0; start < rows.length; start += 2_000) {
          await prisma.medication.createMany({ data: rows.slice(start, start + 2_000), skipDuplicates: true });
        }
        await prisma.$executeRawUnsafe('ANALYZE "Medication"');
      }
      expect(await prisma.medication.count()).toBeGreaterThan(20_000);

      const samples: number[] = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const started = performance.now();
        const res = await request(app).get('/medications?q=amox').set('Authorization', `Bearer ${doctorToken}`);
        samples.push(performance.now() - started);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.floor(samples.length * 0.95) - 1];
      // Generous ceiling for a loaded CI runner; a sequential scan over 30k
      // rows measured well above this here, an index scan is single-digit ms.
      expect(p95, `p95=${p95.toFixed(1)}ms samples=${samples.map((s) => s.toFixed(1)).join(',')}`).toBeLessThan(500);
    });
  });

  describe('structured prescription items', () => {
    it('links a catalog medication and snapshots its display name onto the item', async () => {
      const res = await request(app)
        .post(prescriptionsUrl())
        .set('Authorization', `Bearer ${doctorToken}`)
        .send(body([{ medicationId: amoxicillinId, dosage: '1 capsule', frequency: 'three times daily', duration: '7 days' }]));

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        medicationId: amoxicillinId,
        drugName: 'Amoxicillin 500 mg capsule',
        dosage: '1 capsule',
        frequency: 'three times daily',
        duration: '7 days',
        flaggedForPharmacistReview: false,
      });

      const stored = await prisma.prescriptionItem.findUniqueOrThrow({ where: { id: res.body.items[0].id } });
      expect(stored.medicationId).toBe(amoxicillinId);
      expect(stored.drugName).toBe('Amoxicillin 500 mg capsule');
    });

    it('accepts the explicit unlisted-medication path with free text, flagged for review', async () => {
      const res = await request(app)
        .post(prescriptionsUrl())
        .set('Authorization', `Bearer ${doctorToken}`)
        .send(body([{ drugName: 'Some imported syrup', dosage: '5 ml', frequency: 'twice daily', duration: '3 days' }]));

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.items[0]).toMatchObject({
        medicationId: null,
        drugName: 'Some imported syrup',
        flaggedForPharmacistReview: true,
      });
    });

    it('rejects an unknown medicationId and writes no prescription row', async () => {
      const before = await prisma.prescription.count();
      const res = await request(app)
        .post(prescriptionsUrl())
        .set('Authorization', `Bearer ${doctorToken}`)
        .send(body([
          { medicationId: '00000000-0000-4000-8000-000000000000', dosage: '1', frequency: 'daily', duration: '1 day' },
        ]));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNKNOWN_MEDICATION');
      expect(await prisma.prescription.count()).toBe(before);
    });

    it('rejects an item that supplies neither medicationId nor drugName', async () => {
      const res = await request(app)
        .post(prescriptionsUrl())
        .set('Authorization', `Bearer ${doctorToken}`)
        .send(body([{ dosage: '1', frequency: 'daily', duration: '1 day' }]));
      expect(res.status).toBe(400);
    });

    it('never rewrites an issued prescription when the catalog row changes', async () => {
      const issued = await request(app)
        .post(prescriptionsUrl())
        .set('Authorization', `Bearer ${doctorToken}`)
        .send(body([{ medicationId: snapshotMedicationId, dosage: '1 tablet', frequency: 'daily', duration: '5 days' }]));
      expect(issued.status, JSON.stringify(issued.body)).toBe(201);
      expect(issued.body.items[0].drugName).toBe('Snapshotmycin 250 mg tablet');

      // A catalog correction / re-import: rename and restrength the row.
      await prisma.medication.update({
        where: { id: snapshotMedicationId },
        data: { genericName: 'Snapshotmycin XR', strength: '500 mg' },
      });

      const stored = await prisma.prescriptionItem.findUniqueOrThrow({ where: { id: issued.body.items[0].id } });
      expect(stored.drugName).toBe('Snapshotmycin 250 mg tablet');
      expect(stored.medicationId).toBe(snapshotMedicationId);

      // A *new* prescription against the corrected row snapshots the new name
      // — history is immutable, the vocabulary is not.
      const after = await request(app)
        .post(prescriptionsUrl())
        .set('Authorization', `Bearer ${doctorToken}`)
        .send(body([{ medicationId: snapshotMedicationId, dosage: '1 tablet', frequency: 'daily', duration: '5 days' }]));
      expect(after.status, JSON.stringify(after.body)).toBe(201);
      expect(after.body.items[0].drugName).toBe('Snapshotmycin XR 500 mg tablet');
    });
  });
});
