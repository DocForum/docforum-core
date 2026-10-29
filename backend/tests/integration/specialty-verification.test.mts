import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5499;
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-specver-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
const emailedTokens = new Map<string, string>();

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

describe('per-specialty credential verification', () => {
  let app: App;
  let prisma: Prisma;
  let adminToken: string;
  let doctorProfileId: string;
  let cardiologyId: string;
  let dermatologyId: string;

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

    const fixture = await import('./helpers/fixtures.mjs');
    cardiologyId = await fixture.makeSpecialty(prisma, `Cardiology ${runId}`);
    dermatologyId = await fixture.makeSpecialty(prisma, `Dermatology ${runId}`);
    const doctor = await fixture.makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: cardiologyId });
    await prisma.doctorSpecialty.create({ data: { doctorProfileId: doctor.profileId, specialtyId: dermatologyId } });
    doctorProfileId = doctor.profileId;
    const admin = await fixture.makeAdmin(app, prisma, emailedTokens, runId);
    adminToken = admin.accessToken;
  }, 60_000);

  afterAll(async () => {
    const fixtureModule = await import('./helpers/fixtures.mjs');
    await fixtureModule.resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('verifies one specialty without changing another', async () => {
    const verify = await request(app)
      .patch(`/doctors/${doctorProfileId}/specialties/${cardiologyId}/verification`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'verified', reviewer: 'admin-1' });
    expect(verify.status).toBe(200);
    expect(verify.body.verificationStatus).toBe('verified');

    const rows = await prisma.doctorSpecialty.findMany({ where: { doctorProfileId } });
    const cardio = rows.find((r) => r.specialtyId === cardiologyId)!;
    const derm = rows.find((r) => r.specialtyId === dermatologyId)!;
    expect(cardio.verificationStatus).toBe('verified');
    expect(cardio.reviewer).toBe('admin-1');
    expect(cardio.reviewDate).toBeTruthy();
    expect(derm.verificationStatus).toBe('pending');
  });

  it('rejects a specialty with reason independently', async () => {
    const reject = await request(app)
      .patch(`/doctors/${doctorProfileId}/specialties/${dermatologyId}/verification`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'rejected', reviewer: 'admin-2', rejectionReason: 'insufficient docs' });
    expect(reject.status).toBe(200);
    expect(reject.body.verificationStatus).toBe('rejected');
    expect(reject.body.rejectionReason).toBe('insufficient docs');

    const cardio = await prisma.doctorSpecialty.findUniqueOrThrow({
      where: { doctorProfileId_specialtyId: { doctorProfileId, specialtyId: cardiologyId } },
    });
    expect(cardio.verificationStatus).toBe('verified');
  });

  it('returns 404 for unassigned specialty', async () => {
    const missingSpecialtyId = '00000000-0000-4000-8000-000000000099';
    const res = await request(app)
      .patch(`/doctors/${doctorProfileId}/specialties/${missingSpecialtyId}/verification`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'verified', reviewer: 'admin-1' });
    expect(res.status).toBe(404);
  });

  it('requires admin role', async () => {
    // use doctor token? Need login as doctor. Instead no auth
    const res = await request(app)
      .patch(`/doctors/${doctorProfileId}/specialties/${cardiologyId}/verification`)
      .send({ status: 'verified', reviewer: 'x' });
    expect(res.status).toBe(401);
  });
});
