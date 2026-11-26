// Integration tests for doctor time zone signup, profile updates, and UTC preservation
// (Phase 1, issue #360).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5488;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-tz-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_tz_test`;
process.env.DATABASE_URL = databaseUrl;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

const emailedTokens = new Map<string, string>();

describe('doctor time zone configuration and profile updates (issue #360)', () => {
  let app: App;
  let prisma: Prisma;
  let fixtures: typeof import('./helpers/fixtures.mjs');

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_tz_test');

    execFileSync(
      process.execPath,
      [path.join(BACKEND_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      { cwd: BACKEND_ROOT, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' },
    );

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    fixtures = (await import('./helpers/fixtures.mjs')) as any;

    app = appModule.createApp();
    prisma = dbModule.prisma;
    await fixtures.installEmailCapture(emailedTokens);
  }, 120_000);

  afterAll(async () => {
    await fixtures.resetEmailSenderFixture();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('signup timeZone handling (POST /auth/signup)', () => {
    it('sets specified canonical IANA timeZone on doctor signup', async () => {
      const email = `tz-doc-lagos-${runId}@example.com`;
      const res = await request(app).post('/auth/signup').send({
        role: 'doctor',
        email,
        password: 'longenough123',
        fullName: 'Dr. Lagos Resident',
        timeZone: 'Africa/Lagos',
      });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();

      const token = emailedTokens.get(email);
      expect(token).toBeDefined();
      const verifyRes = await request(app).post('/auth/verify-email').send({ token });
      expect(verifyRes.status).toBe(200);

      const profile = await prisma.doctorProfile.findUniqueOrThrow({
        where: { userId: res.body.user.id },
      });
      expect(profile.timeZone).toBe('Africa/Lagos');

      // Verify GET /doctors/me returns the set timeZone
      const meRes = await request(app)
        .get('/doctors/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(meRes.status).toBe(200);
      expect(meRes.body.timeZone).toBe('Africa/Lagos');
    });

    it('defaults to UTC when timeZone is omitted for doctor signup', async () => {
      const email = `tz-doc-default-${runId}@example.com`;
      const res = await request(app).post('/auth/signup').send({
        role: 'doctor',
        email,
        password: 'longenough123',
        fullName: 'Dr. Default Zone',
      });

      expect(res.status).toBe(200);

      const profile = await prisma.doctorProfile.findUniqueOrThrow({
        where: { userId: res.body.user.id },
      });
      expect(profile.timeZone).toBe('UTC');

      const meRes = await request(app)
        .get('/doctors/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(meRes.status).toBe(200);
      expect(meRes.body.timeZone).toBe('UTC');
    });

    it('rejects doctor signup with non-canonical or invalid time zone', async () => {
      const email = `tz-doc-bad-${runId}@example.com`;
      const badTzRes = await request(app).post('/auth/signup').send({
        role: 'doctor',
        email,
        password: 'longenough123',
        fullName: 'Dr. Bad Zone',
        timeZone: 'Fake/Zone',
      });
      expect(badTzRes.status).toBe(400);

      const aliasRes = await request(app).post('/auth/signup').send({
        role: 'doctor',
        email,
        password: 'longenough123',
        fullName: 'Dr. Alias Zone',
        timeZone: 'EST',
      });
      expect(aliasRes.status).toBe(400);
    });

    it('rejects patient signup with timeZone parameter', async () => {
      const email = `tz-patient-bad-${runId}@example.com`;
      const res = await request(app).post('/auth/signup').send({
        role: 'patient',
        email,
        password: 'longenough123',
        fullName: 'Patient Disallowed TZ',
        timeZone: 'America/New_York',
      });

      expect(res.status).toBe(400);
      expect(res.text).toContain('timeZone is only valid for doctor accounts');
    });

    it('accepts patient signup without timeZone parameter', async () => {
      const email = `tz-patient-ok-${runId}@example.com`;
      const res = await request(app).post('/auth/signup').send({
        role: 'patient',
        email,
        password: 'longenough123',
        fullName: 'Patient Standard',
      });

      expect(res.status).toBe(200);
    });
  });

  describe('doctor profile timeZone update (PATCH /doctors/me)', () => {
    let doctorToken: string;
    let doctorProfileId: string;

    beforeAll(async () => {
      const doc = await fixtures.makeDoctor(app, prisma, emailedTokens, runId);
      doctorToken = doc.accessToken;
      doctorProfileId = doc.profileId;
    });

    it('requires If-Match precondition header', async () => {
      const res = await request(app)
        .patch('/doctors/me')
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ timeZone: 'America/New_York' });

      expect(res.status).toBe(428);
    });

    it('rejects invalid timeZone on profile update', async () => {
      const getRes = await request(app)
        .get('/doctors/me')
        .set('Authorization', `Bearer ${doctorToken}`);
      const etag = getRes.headers.etag;

      const badTzRes = await request(app)
        .patch('/doctors/me')
        .set('Authorization', `Bearer ${doctorToken}`)
        .set('If-Match', etag)
        .send({ timeZone: 'EST' });

      expect(badTzRes.status).toBe(400);
    });

    it('updates timeZone successfully and increments version', async () => {
      const getRes = await request(app)
        .get('/doctors/me')
        .set('Authorization', `Bearer ${doctorToken}`);
      const etag = getRes.headers.etag;
      const initialVersion = getRes.body.version;

      const patchRes = await request(app)
        .patch('/doctors/me')
        .set('Authorization', `Bearer ${doctorToken}`)
        .set('If-Match', etag)
        .send({ timeZone: 'America/Chicago' });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.timeZone).toBe('America/Chicago');
      expect(patchRes.body.version).toBe(initialVersion + 1);
      expect(patchRes.headers.etag).toBe(`"${initialVersion + 1}"`);

      // Verify DB persistence
      const profile = await prisma.doctorProfile.findUniqueOrThrow({
        where: { id: doctorProfileId },
      });
      expect(profile.timeZone).toBe('America/Chicago');
      expect(profile.version).toBe(initialVersion + 1);
    });

    it('allows updating fullName while preserving timeZone', async () => {
      const getRes = await request(app)
        .get('/doctors/me')
        .set('Authorization', `Bearer ${doctorToken}`);
      const etag = getRes.headers.etag;

      const patchRes = await request(app)
        .patch('/doctors/me')
        .set('Authorization', `Bearer ${doctorToken}`)
        .set('If-Match', etag)
        .send({ fullName: 'Dr. Renamed Chicago' });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.fullName).toBe('Dr. Renamed Chicago');
      expect(patchRes.body.timeZone).toBe('America/Chicago');
    });

    it('allows updating both fullName and timeZone simultaneously', async () => {
      const getRes = await request(app)
        .get('/doctors/me')
        .set('Authorization', `Bearer ${doctorToken}`);
      const etag = getRes.headers.etag;

      const patchRes = await request(app)
        .patch('/doctors/me')
        .set('Authorization', `Bearer ${doctorToken}`)
        .set('If-Match', etag)
        .send({ fullName: 'Dr. Both Updated', timeZone: 'Asia/Tokyo' });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.fullName).toBe('Dr. Both Updated');
      expect(patchRes.body.timeZone).toBe('Asia/Tokyo');
    });
  });

  describe('slot and appointment timestamp immutability across timeZone changes', () => {
    it('preserves absolute UTC timestamps of existing slots and appointments when timeZone changes', async () => {
      const doc = await fixtures.makeDoctor(app, prisma, emailedTokens, runId + 100);

      // Create a slot at a known fixed future UTC timestamp (tomorrow, within default 14-day window)
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1_000);
      tomorrow.setMinutes(0, 0, 0);
      const startUtc = new Date(tomorrow.getTime());
      const endUtc = new Date(tomorrow.getTime() + 30 * 60 * 1_000);

      const slot = await prisma.availabilitySlot.create({
        data: {
          doctorProfileId: doc.profileId,
          startTime: startUtc,
          endTime: endUtc,
          status: 'open',
        },
      });

      const initialStartIso = slot.startTime.toISOString();
      const initialEndIso = slot.endTime.toISOString();

      // Now update the doctor's time zone to 'Asia/Tokyo' (UTC+9)
      const getRes = await request(app)
        .get('/doctors/me')
        .set('Authorization', `Bearer ${doc.accessToken}`);
      const etag = getRes.headers.etag;

      const patchRes = await request(app)
        .patch('/doctors/me')
        .set('Authorization', `Bearer ${doc.accessToken}`)
        .set('If-Match', etag)
        .send({ timeZone: 'Asia/Tokyo' });
      expect(patchRes.status).toBe(200);

      // Check slot in DB again
      const slotAfter = await prisma.availabilitySlot.findUniqueOrThrow({
        where: { id: slot.id },
      });
      expect(slotAfter.startTime.toISOString()).toBe(initialStartIso);
      expect(slotAfter.endTime.toISOString()).toBe(initialEndIso);

      // Public slots API also reflects the unchanged UTC instant
      const slotsApiRes = await request(app).get(`/availability/doctors/${doc.profileId}/slots`);
      expect(slotsApiRes.status).toBe(200);
      const matchingSlot = slotsApiRes.body.find((s: any) => s.id === slot.id);
      expect(matchingSlot).toBeDefined();
      expect(matchingSlot.startTime).toBe(initialStartIso);
      expect(matchingSlot.endTime).toBe(initialEndIso);
    });
  });
});
