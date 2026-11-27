// Integration tests for issues #325 and #326:
//   #325 — GET /payments/intents (admin list with filters, keyset pagination)
//   #326 — GET /payments/intents/:id (owner-scoped read for patient + facility)
//
// Self-contained embedded Postgres on port 5502.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import EmbeddedPostgres from 'embedded-postgres';
import { createOrderFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5502;
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-admin-intents-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_admin_intents_test`;

describe('admin payment intent list + owner read (issues #325, #326)', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;

  let adminToken: string;
  let patient: { userId: string; profileId: string; token: string };
  let patientB: { userId: string; profileId: string; token: string };
  let facility: { userId: string; profileId: string; token: string };
  let facilityB: { userId: string; profileId: string; token: string };
  let intent1Id: string;

  function token(userId: string, role: 'patient' | 'facility' | 'admin') {
    return jwt.sign({ sub: userId, role }, 'test-access-secret', { expiresIn: '15m' });
  }

  async function makeUser(label: string, role: 'patient' | 'facility' | 'admin') {
    return prisma.user.create({
      data: { email: `${label}-${runId}@example.com`, passwordHash: 'unused', role, emailVerifiedAt: new Date() },
    });
  }

  async function makeIntent(input: {
    patientProfileId: string;
    facilityId: string;
    status?: string;
    assetCode?: string;
    amountStroops?: bigint;
  }) {
    const order = await createOrderFixture(prisma as never, {
      patientProfileId: input.patientProfileId,
      facilityProfileId: input.facilityId,
      kind: 'lab_order',
      amountStroops: input.amountStroops ?? 500_000n,
      tag: `admin-intents-${runId}-${Math.random().toString(36).slice(2)}`,
    });
    return prisma.paymentIntent.create({
      data: {
        labOrderId: order.id,
        patientProfileId: input.patientProfileId,
        facilityId: input.facilityId,
        status: (input.status ?? 'created') as any,
        amount: input.amountStroops ?? 500_000n,
        assetCode: input.assetCode ?? 'XLM',
      },
    });
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_admin_intents_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;

    prisma = (await import('../../src/db/prisma-client.js')).prisma;
    app = (await import('../../src/app.js')).createApp();

    // Admin
    const adminUser = await makeUser('admin-intents-admin', 'admin');
    adminToken = token(adminUser.id, 'admin');

    // Patients
    const patientUser = await makeUser('admin-intents-patient-a', 'patient');
    const patientProfile = await prisma.patientProfile.create({ data: { userId: patientUser.id, fullName: 'Patient A' } });
    patient = { userId: patientUser.id, profileId: patientProfile.id, token: token(patientUser.id, 'patient') };

    const patientBUser = await makeUser('admin-intents-patient-b', 'patient');
    const patientBProfile = await prisma.patientProfile.create({ data: { userId: patientBUser.id, fullName: 'Patient B' } });
    patientB = { userId: patientBUser.id, profileId: patientBProfile.id, token: token(patientBUser.id, 'patient') };

    // Facilities
    const facilityUser = await makeUser('admin-intents-facility-a', 'facility');
    const facilityProfile = await prisma.facilityProfile.create({ data: { userId: facilityUser.id, name: 'Facility A', type: 'lab' } });
    facility = { userId: facilityUser.id, profileId: facilityProfile.id, token: token(facilityUser.id, 'facility') };

    const facilityBUser = await makeUser('admin-intents-facility-b', 'facility');
    const facilityBProfile = await prisma.facilityProfile.create({ data: { userId: facilityBUser.id, name: 'Facility B', type: 'lab' } });
    facilityB = { userId: facilityBUser.id, profileId: facilityBProfile.id, token: token(facilityBUser.id, 'facility') };

    // Create test intents.
    const i1 = await makeIntent({ patientProfileId: patient.profileId, facilityId: facility.profileId, status: 'created', assetCode: 'XLM' });
    intent1Id = i1.id;
    // Second intent (escrowed) for status filter test.
    await makeIntent({ patientProfileId: patientB.profileId, facilityId: facilityB.profileId, status: 'escrowed', assetCode: 'XLM', amountStroops: 1_000_000n });
    // Third intent for filter tests.
    await makeIntent({ patientProfileId: patient.profileId, facilityId: facilityB.profileId, status: 'released' });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
  });

  // ---- #325: admin list -------------------------------------------------------

  describe('GET /payments/intents (admin list, issue #325)', () => {
    it('requires admin role', async () => {
      expect((await request(app).get('/payments/intents').set('Authorization', `Bearer ${patient.token}`)).status).toBe(403);
      expect((await request(app).get('/payments/intents').set('Authorization', `Bearer ${facility.token}`)).status).toBe(403);
      expect((await request(app).get('/payments/intents')).status).toBe(401);
    });

    it('returns all intents for admin with no filters', async () => {
      const res = await request(app)
        .get('/payments/intents')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBeGreaterThanOrEqual(3);
    });

    it('filters by status', async () => {
      const res = await request(app)
        .get('/payments/intents?status=escrowed')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items.every((item: { status: string }) => item.status === 'escrowed')).toBe(true);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by facilityId', async () => {
      const res = await request(app)
        .get(`/payments/intents?facilityId=${facility.profileId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items.every((item: { facilityId: string }) => item.facilityId === facility.profileId)).toBe(true);
    });

    it('filters by patientProfileId', async () => {
      const res = await request(app)
        .get(`/payments/intents?patientProfileId=${patient.profileId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items.every((item: { patientProfileId: string }) => item.patientProfileId === patient.profileId)).toBe(true);
    });

    it('returns amounts as strings (BigInt-safe)', async () => {
      const res = await request(app)
        .get('/payments/intents')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      for (const item of res.body.items) {
        expect(typeof item.amount).toBe('string');
      }
    });

    it('paginates with limit and returns nextCursor', async () => {
      const res = await request(app)
        .get('/payments/intents?limit=1')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.nextCursor).toBeTruthy();

      const page2 = await request(app)
        .get(`/payments/intents?limit=1&cursor=${res.body.nextCursor}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.items[0].id).not.toBe(res.body.items[0].id);
    });

    it('rejects unknown query params (strict schema)', async () => {
      const res = await request(app)
        .get('/payments/intents?unknown=foo')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
    });
  });

  // ---- #326: owner-scoped read ------------------------------------------------

  describe('GET /payments/intents/:id (owner-scoped, issue #326)', () => {
    it('patient payer can read their own intent', async () => {
      const res = await request(app)
        .get(`/payments/intents/${intent1Id}`)
        .set('Authorization', `Bearer ${patient.token}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(intent1Id);
      expect(typeof res.body.amount).toBe('string');
    });

    it('facility payee can read their own intent', async () => {
      const res = await request(app)
        .get(`/payments/intents/${intent1Id}`)
        .set('Authorization', `Bearer ${facility.token}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(intent1Id);
    });

    it('patient who is not the payer gets 404', async () => {
      // patientB did not create intent1 (which belongs to patient).
      const res = await request(app)
        .get(`/payments/intents/${intent1Id}`)
        .set('Authorization', `Bearer ${patientB.token}`);
      expect(res.status).toBe(404);
    });

    it('facility that is not the payee gets 404', async () => {
      // facilityB is not the payee for intent1.
      const res = await request(app)
        .get(`/payments/intents/${intent1Id}`)
        .set('Authorization', `Bearer ${facilityB.token}`);
      expect(res.status).toBe(404);
    });

    it('admin gets full intent (including patientProfileId, facilityId)', async () => {
      const res = await request(app)
        .get(`/payments/intents/${intent1Id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.patientProfileId).toBeTruthy();
      expect(res.body.facilityId).toBeTruthy();
    });

    it('owner view does not expose preparedTxHash, preparedExpiryLedger, preparedExpiresAt', async () => {
      const res = await request(app)
        .get(`/payments/intents/${intent1Id}`)
        .set('Authorization', `Bearer ${patient.token}`);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('preparedTxHash');
      expect(res.body).not.toHaveProperty('preparedExpiryLedger');
      expect(res.body).not.toHaveProperty('preparedExpiresAt');
    });

    it('unauthenticated request gets 401', async () => {
      const res = await request(app).get(`/payments/intents/${intent1Id}`);
      expect(res.status).toBe(401);
    });

    it('non-existent intent returns 404 for all roles', async () => {
      const fake = '00000000-0000-0000-0000-000000000000';
      expect((await request(app).get(`/payments/intents/${fake}`).set('Authorization', `Bearer ${adminToken}`)).status).toBe(404);
      expect((await request(app).get(`/payments/intents/${fake}`).set('Authorization', `Bearer ${patient.token}`)).status).toBe(404);
      expect((await request(app).get(`/payments/intents/${fake}`).set('Authorization', `Bearer ${facility.token}`)).status).toBe(404);
    });
  });
});
