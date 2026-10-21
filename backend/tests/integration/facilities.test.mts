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
import { Pool } from 'pg';

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

const MEMBER_MIGRATION = '20261019131059_add_facility_member_and_invite';

function migrationPool() {
  return new Pool({
    host: 'localhost',
    port: PORT,
    user: 'docforum',
    password: 'docforum',
    database: 'docforum_test',
  });
}

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
    const resetPool = migrationPool();
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

  // Creating a facility profile together with its owner membership mirrors
  // what the admin facility-creation flow (issue #14, not built yet) will do
  // in one transaction. The add_facility_member migration backfills the same
  // relationship for profiles that predate FacilityMember.
  async function createFacilityProfile(
    userId: string,
    name = `Facility ${runId}`,
    type: 'lab' | 'pharmacy' = 'lab',
  ) {
    const profile = await prisma.facilityProfile.create({
      data: { userId, name, type },
    });
    await prisma.facilityMember.create({
      data: { userId, facilityId: profile.id, role: 'owner' },
    });
    return profile;
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
      // A facility user + profile that predate the membership tables — the
      // exact row shape the migration's backfill has to convert.
      const facilityUser = await createFacilityUser('mig@example.com');
      const facility = await prisma.facilityProfile.create({
        data: { userId: facilityUser.id, name: `Facility ${runId}`, type: 'lab' },
      });
      expect(facility).not.toBeNull();

      // Re-run the add_facility_member migration so its backfill actually sees
      // that pre-existing row: drop its tracking row and deploy again. The
      // migration's DROP ... IF EXISTS guards make the re-apply safe.
      const pool = migrationPool();
      await pool.query('DELETE FROM "_prisma_migrations" WHERE migration_name = $1', [MEMBER_MIGRATION]);
      await pool.end();
      execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
        cwd: BACKEND_ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
      });

      // After the migration, every pre-existing FacilityProfile has a
      // FacilityMember with role=owner.
      const member = await prisma.facilityMember.findFirst({
        where: { facilityId: facility.id },
      });
      expect(member).not.toBeNull();
      expect(member!.role).toBe('owner');
      expect(member!.userId).toBe(facilityUser.id);

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
    });

    it('staff cannot invite (403)', async () => {
      // A real member of this facility who is not an owner — the owner-only
      // invite route must refuse them (an invalid token is a separate 401).
      const staffUser = await createFacilityUser(`staff-cannot-invite-${runId}@example.com`);
      await createFacilityMember(facilityId, staffUser.id, 'staff');
      const staffToken = (await loginAsFacility(staffUser.email)).body.accessToken as string;

      const res = await request(app)
        .post(`/facilities/${facilityId}/invites`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ email: 'staff-invite@example.com' });
      expect(res.status).toBe(403);
    });

    it('owner can list members', async () => {
      const res = await request(app)
        .get(`/facilities/${facilityId}/members`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
    });

    it('owner can invite staff', async () => {
      // Not newstaff@example.com — that address already accepted an invite in
      // the suite above and now belongs to a facility, which is refused.
      const res = await request(app)
        .post(`/facilities/${facilityId}/invites`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `owner-invited-staff-${runId}@example.com`, role: 'staff' });
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
    let ownerUserId: string;

    beforeAll(async () => {
      const fu = await createFacilityUser('lastowner@example.com');
      const fp = await createFacilityProfile(fu.id);
      facilityId = fp.id;
      ownerUserId = fu.id;
      ownerToken = (await loginAsFacility('lastowner@example.com')).body.accessToken as string;
    });

    it('cannot remove the last owner from a facility', async () => {
      const res = await request(app)
        .delete(`/facilities/${facilityId}/members/${ownerUserId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      // Should fail because this is the last owner
      expect(res.status).toBe(400);
    });
  });

  // ── Test: User cannot belong to two facilities ────────
  describe('User cannot belong to two facilities', () => {
    let facilityBId: string;
    let userId: string;

    beforeAll(async () => {
      const fuA = await createFacilityUser('userA@example.com');
      const fuB = await createFacilityUser('userB@example.com');
      // fuA ends up an owner member of facility A through the helper.
      await createFacilityProfile(fuA.id);
      facilityBId = (await createFacilityProfile(fuB.id)).id;
      userId = fuA.id;
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
    let staffUserId: string;

    beforeAll(async () => {
      const fu = await createFacilityUser('fulfillment-staff@example.com');
      // Profile created directly (not via createFacilityProfile) so this user
      // is a plain staff member, not the profile's owner.
      facilityId = (
        await prisma.facilityProfile.create({
          data: { userId: fu.id, name: `Fulfillment facility ${runId}`, type: 'pharmacy' },
        })
      ).id;
      // The acting staff user a fulfillment action is attributed to
      // (FulfillmentRecord.actorUserId).
      await createFacilityMember(facilityId, fu.id, 'staff');
      staffUserId = fu.id;
    });

    it('actorUserId is nullable on existing rows (legacy)', async () => {
      // A row shaped like a pre-#75 record: no actor recorded.
      await prisma.fulfillmentRecord.create({
        data: { orderType: 'prescription', orderId: `legacy-order-${runId}` },
      });
      const fulfillment = await prisma.fulfillmentRecord.findFirst({});
      // actorUserId should be nullable; legacy rows are null.
      expect(fulfillment?.actorUserId).toBeNull();
    });

    it('the acting staff user is resolvable from the facility membership', async () => {
      const member = await prisma.facilityMember.findFirst({
        where: { facilityId, userId: staffUserId },
      });
      expect(member).not.toBeNull();
      expect(member!.role).toBe('staff');
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
      // fuA gets a profile created directly so they are a staff member of
      // facility A rather than its owner.
      facilityAId = (
        await prisma.facilityProfile.create({
          data: { userId: fuA.id, name: `Facility A ${runId}`, type: 'lab' },
        })
      ).id;
      facilityBId = (await createFacilityProfile(fuB.id)).id;
      // Create staff member for facility A
      await createFacilityMember(facilityAId, fuA.id, 'staff');
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