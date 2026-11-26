// Issue #60 integration coverage: symptom -> specialty mapping (controlled
// vocabulary, no ML). Real embedded Postgres (port 5482) and HTTP only for
// the vocabulary and search surfaces; doctors/specialties are set up through
// the shared fixtures because doctor verification is another issue's scope.
//
// What this proves:
//  - the reviewed starter set is present and autocomplete uses prefix +
//    trigram matching while excluding retired symptoms;
//  - `GET /doctors?symptom=` returns verified doctors ordered by mapping
//    strength (dermatology before family medicine for "rash"), never
//    unverified ones, and paginates with the existing keyset cursor;
//  - an unknown or unmapped symptom is an empty result with a hint, not an
//    error;
//  - admins can create, rename, retire and re-map a symptom, invalid weights
//    and unknown specialties are rejected, and non-admins are refused.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5482; // unique per integration file
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-symptoms-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
  initdbFlags: ['-E', 'UTF8'],
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_symptoms_test`;
const emailedTokens = new Map<string, string>();

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

describe('symptom-to-specialty mapping (issue #60)', () => {
  let app: App;
  let prisma: Prisma;
  let adminToken: string;
  let patientToken: string;
  let dermatologyId: string;
  let familyMedicineId: string;
  let cardiologyId: string;
  let dermatologistId: string;
  let familyDoctorId: string;
  let cardiologistId: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_symptoms_test');
    execFileSync(process.execPath, [path.join(BACKEND_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const fixtureModule = await import('./helpers/fixtures.mjs');
    await fixtureModule.installEmailCapture(emailedTokens);
    app = appModule.createApp();
    prisma = dbModule.prisma;

    // The starter vocabulary maps onto the specialties the base migrations
    // seed — use those rows, so this also proves the shipped seed is wired up.
    dermatologyId = (await prisma.specialty.findUniqueOrThrow({ where: { slug: 'dermatology' } })).id;
    familyMedicineId = (await prisma.specialty.findUniqueOrThrow({ where: { slug: 'family-medicine' } })).id;
    cardiologyId = (await prisma.specialty.findUniqueOrThrow({ where: { slug: 'cardiology' } })).id;

    // Family medicine first so the expected order cannot be insertion order.
    const familyDoctor = await fixtureModule.makeDoctor(app, prisma, emailedTokens, runId, {
      specialtyId: familyMedicineId,
    });
    familyDoctorId = familyDoctor.profileId;
    const dermatologist = await fixtureModule.makeDoctor(app, prisma, emailedTokens, runId + 1, {
      specialtyId: dermatologyId,
    });
    dermatologistId = dermatologist.profileId;
    const cardiologist = await fixtureModule.makeDoctor(app, prisma, emailedTokens, runId + 2, {
      specialtyId: cardiologyId,
    });
    cardiologistId = cardiologist.profileId;

    // A pending (unverified) dermatologist must never appear in results.
    const pending = await fixtureModule.makeDoctor(app, prisma, emailedTokens, runId + 3, {
      specialtyId: dermatologyId,
    });
    await prisma.doctorProfile.update({
      where: { id: pending.profileId },
      data: { verificationStatus: 'pending' },
    });

    const admin = await fixtureModule.makeAdmin(app, prisma, emailedTokens, runId);
    adminToken = admin.accessToken;
    const patient = await fixtureModule.makePatient(app, emailedTokens, runId);
    patientToken = patient.accessToken;
  }, 180_000);

  afterAll(async () => {
    const fixtureModule = await import('./helpers/fixtures.mjs');
    await fixtureModule.resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (_err) {
      void _err;
    }
  });

  it('seeds the reviewed vocabulary and autocompletes by prefix', async () => {
    const all = await request(app).get('/symptoms').query({ limit: 50 });
    expect(all.status).toBe(200);
    expect(all.body.items.map((item: { slug: string }) => item.slug)).toEqual(
      expect.arrayContaining(['rash', 'chest-pain', 'annual-check-up']),
    );

    const prefix = await request(app).get('/symptoms').query({ q: 'ra' });
    expect(prefix.status).toBe(200);
    expect(prefix.body.items[0]).toMatchObject({ name: 'Rash', slug: 'rash' });
    expect(Object.keys(prefix.body.items[0]).sort()).toEqual(['id', 'name', 'slug']);

    const fuzzy = await request(app).get('/symptoms').query({ q: 'palpatations' });
    expect(fuzzy.status).toBe(200);
    expect(fuzzy.body.items.map((item: { slug: string }) => item.slug)).toContain('palpitations');

    const none = await request(app).get('/symptoms').query({ q: 'zzzzzz' });
    expect(none.status).toBe(200);
    expect(none.body.items).toEqual([]);
  });

  it('ranks doctors by mapping strength and returns an empty result with a hint when unmapped', async () => {
    const rash = await request(app).get('/doctors').query({ symptom: 'rash' });
    expect(rash.status).toBe(200);
    const ids = rash.body.items.map((item: { id: string }) => item.id);
    // Rash maps to dermatology (5) and family medicine (2).
    expect(ids).toEqual([dermatologistId, familyDoctorId]);
    expect(ids).not.toContain(cardiologistId);
    expect(rash.body.hint).toBeUndefined();

    const limited = await request(app).get('/doctors').query({ symptom: 'rash', limit: 1 });
    expect(limited.status).toBe(200);
    expect(limited.body.items).toHaveLength(1);
    expect(limited.body.items[0].id).toBe(dermatologistId);
    expect(limited.body.nextCursor).toBe(dermatologistId);

    const secondPage = await request(app)
      .get('/doctors')
      .query({ symptom: 'rash', limit: 1, cursor: limited.body.nextCursor });
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.items.map((item: { id: string }) => item.id)).toEqual([familyDoctorId]);

    const unknown = await request(app).get('/doctors').query({ symptom: 'not-a-symptom' });
    expect(unknown.status).toBe(200);
    expect(unknown.body.items).toEqual([]);
    expect(unknown.body.hint).toContain('Unknown symptom');

    // A symptom that exists but has no mapping is also an empty result + hint.
    const created = await request(app)
      .post('/admin/symptoms')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Unmapped complaint', slug: 'unmapped-complaint' });
    expect(created.status).toBe(201);
    const unmapped = await request(app).get('/doctors').query({ symptom: 'unmapped-complaint' });
    expect(unmapped.status).toBe(200);
    expect(unmapped.body.items).toEqual([]);
    expect(unmapped.body.hint).toContain('No specialties are mapped');
  });

  it('lets admins create, re-map, rename and retire a symptom', async () => {
    const created = await request(app)
      .post('/admin/symptoms')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Fluttering chest' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Fluttering chest', slug: 'fluttering-chest', isRetired: false });

    const duplicate = await request(app)
      .post('/admin/symptoms')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Fluttering chest' });
    expect(duplicate.status).toBe(409);

    const mapped = await request(app)
      .put(`/admin/symptoms/${created.body.id}/specialties`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        mappings: [
          { specialtyId: cardiologyId, weight: 5 },
          { specialtyId: familyMedicineId, weight: 2 },
          // Duplicate id: the highest weight wins instead of failing.
          { specialtyId: cardiologyId, weight: 1 },
        ],
      });
    expect(mapped.status).toBe(200);
    expect(mapped.body.specialties).toEqual([
      expect.objectContaining({ specialtyId: cardiologyId, weight: 5 }),
      expect.objectContaining({ specialtyId: familyMedicineId, weight: 2 }),
    ]);

    const doctorResults = await request(app).get('/doctors').query({ symptom: 'fluttering-chest' });
    expect(doctorResults.status).toBe(200);
    expect(doctorResults.body.items.map((item: { id: string }) => item.id)).toEqual([
      cardiologistId,
      familyDoctorId,
    ]);

    const invalidWeight = await request(app)
      .put(`/admin/symptoms/${created.body.id}/specialties`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mappings: [{ specialtyId: cardiologyId, weight: 6 }] });
    expect(invalidWeight.status).toBe(400);

    const unknownSpecialty = await request(app)
      .put(`/admin/symptoms/${created.body.id}/specialties`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mappings: [{ specialtyId: '00000000-0000-4000-8000-000000000099', weight: 3 }] });
    expect(unknownSpecialty.status).toBe(400);

    const renamed = await request(app)
      .patch(`/admin/symptoms/${created.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Fluttering heartbeat' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Fluttering heartbeat');

    const retired = await request(app)
      .patch(`/admin/symptoms/${created.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isRetired: true });
    expect(retired.status).toBe(200);
    expect(retired.body.isRetired).toBe(true);

    // Retired disappears from autocomplete and from search (treated as unknown).
    const autocomplete = await request(app).get('/symptoms').query({ q: 'Fluttering' });
    expect(autocomplete.body.items).toEqual([]);
    const search = await request(app).get('/doctors').query({ symptom: 'fluttering-chest' });
    expect(search.body.items).toEqual([]);
    expect(search.body.hint).toContain('Unknown symptom');

    const forbidden = await request(app).get('/admin/symptoms').set('Authorization', `Bearer ${patientToken}`);
    expect(forbidden.status).toBe(403);
    const anonymousWrite = await request(app).post('/admin/symptoms').send({ name: 'Anonymous complaint' });
    expect(anonymousWrite.status).toBe(401);
  });
});
