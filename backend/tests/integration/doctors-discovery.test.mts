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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-doctors-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
const emailedTokens = new Map<string, string>();

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

describe('doctor discovery', () => {
  let app: App;
  let prisma: Prisma;
  let cardiologyId: string;
  let dermatologyId: string;
  let cardiologySlug: string;
  let doctor: { userId: string; accessToken: string; profileId: string; email: string };
  let patient: { userId: string; accessToken: string; profileId: string; email: string };

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
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

    cardiologyId = await fixtureModule.makeSpecialty(prisma, `Property Cardiology ${runId}`);
    dermatologyId = await fixtureModule.makeSpecialty(prisma, `Property Dermatology ${runId}`);
    const cardiology = await prisma.specialty.findUniqueOrThrow({ where: { id: cardiologyId } });
    cardiologySlug = cardiology.slug;
    doctor = await fixtureModule.makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: cardiologyId });
    await prisma.doctorProfile.update({ where: { id: doctor.profileId }, data: { fullName: 'Adebayo Adebayor' } });
    patient = await fixtureModule.makePatient(app, emailedTokens, runId);

    const pending = await request(app).post('/auth/signup').send({
      role: 'doctor',
      email: `pending-${runId}@example.test`,
      password: 'longenough123',
      fullName: 'Pending Adebayo',
    });
    expect(pending.status).toBe(200);
    const pendingProfile = await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: pending.body.user.id } });
    await prisma.doctorSpecialty.create({ data: { doctorProfileId: pendingProfile.id, specialtyId: cardiologyId } });

    await fixtureModule.makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: dermatologyId });
    // Keep one similarly named verified profile for typo and prefix searches.
    const second = await request(app).post('/auth/signup').send({
      role: 'doctor',
      email: `adele-${runId}@example.test`,
      password: 'longenough123',
      fullName: 'Adele Dermatologist',
    });
    expect(second.status).toBe(200);
    const secondProfile = await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: second.body.user.id } });
    await prisma.doctorProfile.update({ where: { id: secondProfile.id }, data: { verificationStatus: 'verified' } });
    await prisma.doctorSpecialty.create({ data: { doctorProfileId: secondProfile.id, specialtyId: dermatologyId } });
  }, 30_000);

  afterAll(async () => {
    const fixtureModule = await import('./helpers/fixtures.mjs');
    await fixtureModule.resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists specialties publicly and searches only verified doctors with public fields', async () => {
    const specialties = await request(app).get('/specialties');
    expect(specialties.status).toBe(200);
    expect(specialties.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: cardiologyId, slug: cardiologySlug }),
    ]));

    const results = await request(app).get('/doctors').query({ specialty: cardiologySlug });
    expect(results.status).toBe(200);
    expect(results.body.items).toHaveLength(1);
    expect(results.body.items[0]).toMatchObject({ id: doctor.profileId, fullName: 'Adebayo Adebayor' });
    expect(Object.keys(results.body.items[0]).sort()).toEqual(['fullName', 'id', 'specialties']);
    expect(results.body.items[0].specialties[0]).toMatchObject({ id: cardiologyId, slug: cardiologySlug });
    expect(JSON.stringify(results.body)).not.toContain(doctor.email);

    const unknown = await request(app).get('/doctors').query({ specialty: 'not-a-specialty' });
    expect(unknown.status).toBe(200);
    expect(unknown.body.items).toEqual([]);
  });

  it('uses typo-tolerant matching for longer terms and prefix matching for short terms', async () => {
    const typo = await request(app).get('/doctors').query({ q: 'Adebayor' });
    expect(typo.status).toBe(200);
    expect(typo.body.items.some((entry: { id: string }) => entry.id === doctor.profileId)).toBe(true);

    const prefix = await request(app).get('/doctors').query({ q: 'Ad' });
    expect(prefix.status).toBe(200);
    expect(prefix.body.items.some((entry: { id: string }) => entry.id === doctor.profileId)).toBe(true);
  });

  it('uses stable keyset pagination and lets doctors replace only their own specialty set', async () => {
    const first = await request(app).get('/doctors').query({ limit: 1 });
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(app).get('/doctors').query({ limit: 1, cursor: first.body.nextCursor });
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);

    const replaced = await request(app)
      .put('/doctors/me/specialties')
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({ specialtyIds: [dermatologyId] });
    expect(replaced.status).toBe(200);
    expect(replaced.body.specialties.map((item: { id: string }) => item.id)).toEqual([dermatologyId]);

    const unknown = await request(app)
      .put('/doctors/me/specialties')
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({ specialtyIds: ['00000000-0000-4000-8000-000000000099'] });
    expect(unknown.status).toBe(400);
    const current = await prisma.doctorSpecialty.findMany({ where: { doctorProfileId: doctor.profileId } });
    expect(current.map((item) => item.specialtyId)).toEqual([dermatologyId]);

    const forbidden = await request(app)
      .put('/doctors/me/specialties')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ specialtyIds: [] });
    expect(forbidden.status).toBe(403);
  });
});
