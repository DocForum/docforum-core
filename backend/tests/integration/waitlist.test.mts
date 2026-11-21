import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5476;
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-waitlist-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: true,
  initdbFlags: ['-E', 'UTF8'],
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
const emailedTokens = new Map<string, string>();

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

describe('waitlist uniqueness and lifecycle', () => {
  let app: App;
  let prisma: Prisma;
  let specialtyId: string;
  let doctor: { userId: string; accessToken: string; profileId: string; email: string };
  let patient: { userId: string; accessToken: string; profileId: string; email: string };

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');
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

    specialtyId = await fixtureModule.makeSpecialty(prisma, `Waitlist Specialty ${runId}`);
    doctor = await fixtureModule.makeDoctor(app, prisma, emailedTokens, runId, { specialtyId });
    patient = await fixtureModule.makePatient(app, emailedTokens, runId);
  }, 120_000);

  afterAll(async () => {
    const fixtureModule = await import('./helpers/fixtures.mjs');
    await fixtureModule.resetEmailSenderFixture();
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

  it('allows joining, prevents duplicate active join, and allows re-join after leaving', async () => {
    const earliest = new Date(Date.now() + 3600_000).toISOString();
    const latest = new Date(Date.now() + 86400_000).toISOString();

    // 1. Join waitlist
    const joinRes = await request(app)
      .post('/appointments/waitlist/join')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({
        doctorProfileId: doctor.profileId,
        specialtyId,
        earliestAcceptable: earliest,
        latestAcceptable: latest,
        holdDurationMinutes: 30,
      });
    expect(joinRes.status).toBe(201);
    expect(joinRes.body.status).toBe('pending');
    const entryId = joinRes.body.id;

    // 2. Duplicate join while active should return 409
    const dupRes = await request(app)
      .post('/appointments/waitlist/join')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({
        doctorProfileId: doctor.profileId,
        specialtyId,
        earliestAcceptable: earliest,
        latestAcceptable: latest,
      });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.message).toContain('already on the waitlist');

    // 3. Leave the waitlist
    const leaveRes = await request(app)
      .post('/appointments/waitlist/leave')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ entryId });
    expect(leaveRes.status).toBe(200);

    const leftEntry = await prisma.waitlistEntry.findUnique({ where: { id: entryId } });
    expect(leftEntry?.status).toBe('expired');

    // 4. Re-join the same waitlist now that the previous entry is expired
    const rejoinRes = await request(app)
      .post('/appointments/waitlist/join')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({
        doctorProfileId: doctor.profileId,
        specialtyId,
        earliestAcceptable: earliest,
        latestAcceptable: latest,
      });
    expect(rejoinRes.status).toBe(201);
    expect(rejoinRes.body.status).toBe('pending');
    expect(rejoinRes.body.id).not.toBe(entryId);

    // Clean up: leave again
    await request(app)
      .post('/appointments/waitlist/leave')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ entryId: rejoinRes.body.id });
  });

  it('rejects concurrent duplicate joins at the database level', async () => {
    const fixtureModule = await import('./helpers/fixtures.mjs');
    const secondDoctor = await fixtureModule.makeDoctor(app, prisma, emailedTokens, runId, { specialtyId });

    const earliest = new Date(Date.now() + 3600_000).toISOString();
    const latest = new Date(Date.now() + 86400_000).toISOString();

    const joinPayload = {
      doctorProfileId: secondDoctor.profileId,
      specialtyId,
      earliestAcceptable: earliest,
      latestAcceptable: latest,
    };

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/appointments/waitlist/join')
        .set('Authorization', `Bearer ${patient.accessToken}`)
        .send(joinPayload),
      request(app)
        .post('/appointments/waitlist/join')
        .set('Authorization', `Bearer ${patient.accessToken}`)
        .send(joinPayload),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it('handles null specialty safely with NULLS NOT DISTINCT partial unique index', async () => {
    const fixtureModule = await import('./helpers/fixtures.mjs');
    const thirdDoctor = await fixtureModule.makeDoctor(app, prisma, emailedTokens, runId);

    const earliest = new Date(Date.now() + 3600_000).toISOString();
    const latest = new Date(Date.now() + 86400_000).toISOString();

    // Join with null specialtyId
    const res1 = await request(app)
      .post('/appointments/waitlist/join')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({
        doctorProfileId: thirdDoctor.profileId,
        earliestAcceptable: earliest,
        latestAcceptable: latest,
      });
    expect(res1.status).toBe(201);
    expect(res1.body.specialtyId).toBeNull();

    // Attempting to join the same doctor with null specialtyId again must fail with 409
    const res2 = await request(app)
      .post('/appointments/waitlist/join')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({
        doctorProfileId: thirdDoctor.profileId,
        earliestAcceptable: earliest,
        latestAcceptable: latest,
      });
    expect(res2.status).toBe(409);
    expect(res2.body.message).toContain('already on the waitlist');
  });
});
