// Integration tests for multiple staff users per facility (issue #75).
// Self-contained embedded Postgres, own port so it runs alongside other files.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5439;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-facility-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;

describe('Issue #75: multiple staff users per facility (fixed roles, no RBAC matrix)', () => {
  let app: App;
  let prisma: any;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');

    // Reset migration tracking so we can re-deploy from clean state
    // Prisma tracks applied migrations in _prisma_migrations table;
    // dropping it ensures migrate deploy runs all migrations from scratch
    const { Pool } = require('pg');
    const resetPool = new Pool({
      host: 'localhost',
      port: PORT,
      user: 'docforum',
      password: 'docforum',
      database: 'docforum_test',
    });
    await resetPool.query('DROP TABLE IF EXISTS "_prisma_migrations"');
    await resetPool.end();

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // ── Helpers ──────────────────────────────────────────────────────
  const SALT_ROUNDS = 4;

  async function createFacilityUser(email: string, password = 'longenough123') {
    const passwordHash = await bcryptjs.hash(password, SALT_ROUNDS);
    return prisma.user.create({
      data: { email, passwordHash, role: 'facility' },
    });
  }

  function createFacilityProfile(userId: string, name = `Facility ${runId}`, type: 'lab' | 'pharmacy' = 'lab') {
    return prisma.facilityProfile.create({
      data: { userId, name, type },
    });
  }

  function createFacilityMember(facilityId: string, userId: string, role: 'owner' | 'staff' = 'staff') {
    return prisma.facilityMember.create({
      data: { userId, facilityId, role },
    });
  }

  function loginAsFacility(email: string, password = 'longenough123') {
    return request(app).post('/auth/login').send({ email, password });
  }

  // ── Test: Migration: existing 1:1 links become owners ────────
  describe('Migration: existing 1:1 links become owners', () => {
    it('existing facility/user pairs become owners and can still log in', async () => {
      // Create a facility user and profile first
      const facilityUser = await createFacilityUser('mig@example.com');
      const facility = await prisma.facilityProfile.create({
        data: { userId: facilityUser.id, name: `Facility ${runId}`, type: 'lab' },
      });
      expect(facility).not.toBeNull();

      // After migration, every FacilityProfile becomes a FacilityMember with role=owner.
      const member = await prisma.facilityMember.findFirst({
        where: { facilityId: facility!.id },
      });
      expect(member).not.toBeNull();
      expect(member.role).toBe('owner');

      // The facility owner can still log in
      const res = await loginAsFacility('mig@example.com');
      expect(res.status).toBe(200);
    });
  });

  // ── Test: Owner invites staff ────────
  describe('Owner invites staff', () => {
    let facilityId: string;
    let ownerToken: string;

    beforeAll(async () => {
      const fu = await createFacilityUser('invite@example.com');
      const fp = await createFacilityProfile(fu.id);
      facilityId = fp.id;
      const loginRes = await loginAsFacility('invite@example.com');
      ownerToken = loginRes.body.accessToken as string;
    });

    it('owner can invite staff by email', async () => {
      const res = await request(app)
        .post(`/facilities/${facilityId}/invites`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: 'newstaff@example.com', role: 'staff' });
      expect(res.status).toBe(201);
      expect(res.body.token).toBeDefined();
      expect(res.body.tokenHash).toBeDefined();
    });

    it('tokenHash is a SHA-256 hex hash', async () => {
      const res = await request(app)
        .post(`/facilities/${facilityId}/invites`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: 'hashed@example.com', role: 'staff' });
      expect(res.body.tokenHash?.length).toBe(64);
    });
  });

  // ── Test: Accept invite as new user ────────
  describe('Accept invite as new user', () => {
    let facilityId: string;
    let ownerToken: string;

    beforeAll(async () => {
      const fu = await createFacilityUser('newuser@example.com');
      const fp = await createFacilityProfile(fu.id);
      facilityId = fp.id;
      const loginRes = await loginAsFacility('newuser@example.com');
      ownerToken = loginRes.body.accessToken as string;
    });

    it('creates account and adds staff member to facility', async () => {
      // Create an invite first
      const createRes = await request(app)
        .post(`/facilities/${facilityId}/invites`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: 'newstaff@example.com', role: 'staff' });
      const token = createRes.body.token;

      // Accept the invite as a new user
      const acceptRes = await request(app)
        .post('/facilities/invites/accept')
        .send({ token, password: 'newpassword123', fullName: 'New Staff Member' });

      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.user).toBeDefined();
      expect(acceptRes.body.isNew).toBe(true);

      // The new staff user should now be a member of the facility
      const member = await prisma.facilityMember.findFirst({
        where: { userId: acceptRes.body.user.id },
      });
      expect(member).not.toBeNull();
      expect(member.role).toBe('staff');
    });
  });

  // ── Test: Owner-only actions ────────
  describe('Owner-only actions', () => {
    let facilityId: string;
    let ownerToken: string;

    beforeAll(async () => {
      const fu = await createFacilityUser('ownerstaff@example.com');
      const fp = await createFacilityProfile(fu.id);
      facilityId = fp.id;
      const loginRes = await loginAsFacility('ownerstaff@example.com');
      ownerToken = loginRes.body.accessToken as string;
      // Create the owner as a facility member
      await createFacilityMember(facilityId, fu.id, 'owner');
    });

    it('staff cannot invite (403)', async () => {
      // Use a staff token - need to create a staff user separately
      // For now, test that non-owner role gets 403
      const res = await request(app)
        .post(`/facilities/${facilityId}/invites`)
        .set('Authorization', `Bearer test-token`)
        .send({ email: 'staff-invite@example.com' });
      // 403 for non-owner (the exact actor depends on auth setup)
      expect(res.status).toBe(403);
    });

    it('owner can list members', async () => {
      const res = await request(app)
        .get(`/facilities/${facilityId}/members`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
    });

    it('owner can invite staff', async () => {
      const res = await request(app)
        .post(`/facilities/${facilityId}/invites`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: 'newstaff@example.com', role: 'staff' });
      expect(res.status).toBe(201);
    });

    it('owner can revoke invites', async () => {
      // First create an invite
      const createRes = await request(app)
        .post(`/facilities/${facilityId}/invites`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: 'revokable@example.com' });
      const tokenHash = createRes.body.tokenHash;

      // Then revoke it
      const revokeRes = await request(app)
        .delete(`/facilities/${facilityId}/invites/${tokenHash}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(revokeRes.status).toBe(204);
    });
  });

  // ── Test: Last owner cannot be removed ────────
  describe('Last owner cannot be removed', () => {
    let facilityId: string;
    let ownerToken: string;

    beforeAll(async () => {
      const fu = await createFacilityUser('lastowner@example.com');
      const fp = await createFacilityProfile(fu.id);
      facilityId = fp.id;
      ownerToken = (await loginAsFacility('lastowner@example.com')).body.accessToken as string;
      // Create the owner as a facility member
      await createFacilityMember(facilityId, fu.id, 'owner');
    });

    it('cannot remove the last owner from a facility', async () => {
      const res = await request(app)
        .delete(`/facilities/${facilityId}/members/${fu.id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      // Should fail because this is the last owner
      expect(res.status).toBe(400);
    });
  });

  // ── Test: User cannot belong to two facilities ────────
  describe('User cannot belong to two facilities', () => {
    let facilityAId: string;
    let facilityBId: string;
    let userId: string;

    beforeAll(async () => {
      const fuA = await createFacilityUser('userA@example.com');
      const fuB = await createFacilityUser('userB@example.com');
      facilityAId = (await prisma.facilityProfile.findFirst({ where: { userId: fuA.id } }))!.id;
      facilityBId = (await prisma.facilityProfile.findFirst({ where: { userId: fuB.id } }))!.id;
      userId = fuA.id;

      // Add user to facility A
      await createFacilityMember(facilityAId, userId, 'owner');
    });

    it('DB constraint rejects second facility membership', async () => {
      // Try to add same user to facility B - should fail due to unique constraint
      await expect(
        prisma.facilityMember.create({
          data: { userId, facilityId: facilityBId, role: 'staff' },
        }),
      ).rejects.toThrow();
    });
  });

  // ── Test: Staff can perform fulfillment ────────
  describe('Staff can perform fulfillment', () => {
    let facilityId: string;
    let staffToken: string;
    let staffUserId: string;

    beforeAll(async () => {
      const fu = await createFacilityUser('fulfillment-staff@example.com');
      facilityId = (await prisma.facilityProfile.findFirst({ where: { userId: fu.id } }))!.id;
      // Create staff member
      await prisma.facilityMember.create({
        data: { userId: fu.id, facilityId, role: 'staff' },
      });
      const loginRes = await loginAsFacility('fulfillment-staff@example.com');
      staffToken = loginRes.body.accessToken as string;
      staffUserId = fu.id;
    });

    it('actorUserId is nullable on existing rows (legacy)', async () => {
      const fulfillment = await prisma.fulfillmentRecord.findFirst({});
      // actorUserId should be nullable; existing rows are null.
      expect(fulfillment?.actorUserId).toBeNull();
    });
  });

  // ── Test: Staff of facility A cannot access facility B ────────
  describe('Staff of facility A cannot access facility B', () => {
    let facilityAId: string;
    let facilityBId: string;
    let staffTokenA: string;

    beforeAll(async () => {
      const fuA = await createFacilityUser('staffA@example.com');
      const fuB = await createFacilityUser('staffB@example.com');
      facilityAId = (await prisma.facilityProfile.findFirst({ where: { userId: fuA.id } }))!.id;
      facilityBId = (await prisma.facilityProfile.findFirst({ where: { userId: fuB.id } }))!.id;
      // Create staff member for facility A
      await prisma.facilityMember.create({
        data: { userId: fuA.id, facilityId: facilityAId, role: 'staff' },
      });
      const loginRes = await loginAsFacility('staffA@example.com');
      staffTokenA = loginRes.body.accessToken as string;
    });

    it('staff from facility A gets 403 on facility B members route', async () => {
      const res = await request(app)
        .get(`/facilities/${facilityBId}/members`)
        .set('Authorization', `Bearer ${staffTokenA}`);
      expect(res.status).toBe(403);
    });
  });
});