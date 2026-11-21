// Admin user directory (issue #275) and admin invite list/revoke (issue
// #277) — integration against a real Postgres.
//
// The security-relevant properties are what this suite pins: both endpoints
// are admin-only, the directory returns account-level fields only and marks
// tombstones instead of leaking their placeholder email, and revoke vs
// redeem is decided by one conditional write (a race has exactly one winner).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5474;
const runId = Date.now();
const PASSWORD = 'longenough123';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-admin-dir-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

describe('admin directory and invites', () => {
  let app: App;
  let prisma: Prisma;
  let adminToken: string;
  let patientToken: string;
  let adminId: string;

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

    const [appModule, dbModule, passwordModule] = await Promise.all([
      import('../../src/app.js'),
      import('../../src/db/prisma-client.js'),
      import('../../src/modules/auth/services/password.js'),
    ]);
    app = appModule.createApp();
    prisma = dbModule.prisma;

    const adminEmail = `directory-admin-${runId}@example.com`;
    const admin = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await passwordModule.hashPassword(PASSWORD),
        role: 'admin',
        emailVerifiedAt: new Date(),
      },
    });
    adminId = admin.id;

    const login = await request(app).post('/auth/login').send({ email: adminEmail, password: PASSWORD });
    expect(login.status).toBe(200);
    adminToken = login.body.accessToken as string;

    const patient = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email: `directory-patient-${runId}@example.com`, password: PASSWORD, fullName: 'Directory Patient' });
    expect(patient.status).toBe(200);
    patientToken = patient.body.accessToken as string;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function listUsers(query: string, token = adminToken) {
    return request(app).get(`/admin/users?${query}`).set('Authorization', `Bearer ${token}`);
  }

  function createInvite(email: string) {
    return request(app)
      .post('/admin/invites')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email });
  }

  it('is admin-only and never exposes credentials while marking deleted accounts', async () => {
    expect((await request(app).get('/admin/users')).status).toBe(401);
    expect((await listUsers('limit=5', patientToken)).status).toBe(403);

    const roleOnly = await listUsers('role=admin');
    expect(roleOnly.status).toBe(200);
    expect(roleOnly.body.items).toHaveLength(1);
    expect(roleOnly.body.items[0].id).toBe(adminId);
    // Account-level fields only; anything credential-shaped is absent.
    expect(roleOnly.body.items[0].passwordHash).toBeUndefined();
    expect(roleOnly.body.items[0].tokenVersion).toBeUndefined();
    expect(roleOnly.body.items[0].totpSecret).toBeUndefined();
    expect(roleOnly.body.items[0].emailVerifiedAt).toBeTruthy();
    expect(roleOnly.body.items[0].deleted).toBe(false);

    // Simulate a tombstoned account the way account deletion leaves it: the
    // real address is gone, replaced with the internal placeholder.
    const tombstoned = await prisma.user.findUniqueOrThrow({ where: { email: `directory-patient-${runId}@example.com` } });
    await prisma.user.update({
      where: { id: tombstoned.id },
      data: {
        email: `deleted+${tombstoned.id}@deleted.invalid`,
        deletedAt: new Date(),
      },
    });

    const deletedOnly = await listUsers('state=deleted');
    expect(deletedOnly.status).toBe(200);
    expect(deletedOnly.body.items).toHaveLength(1);
    expect(deletedOnly.body.items[0].email).toBeNull();
    expect(deletedOnly.body.items[0].deleted).toBe(true);
    expect(deletedOnly.body.items[0].deletedAt).not.toBeNull();
    expect(JSON.stringify(deletedOnly.body)).not.toContain('deleted.invalid');
  });

  it('filters by role, state and email prefix, and pages by keyset', async () => {
    const prefix = `dir-${runId}-`;
    for (let index = 0; index < 5; index += 1) {
      const signup = await request(app)
        .post('/auth/signup')
        .send({
          role: 'patient',
          email: `${prefix}${index}@example.com`,
          password: PASSWORD,
          fullName: `Directory User ${index}`,
        });
      expect(signup.status).toBe(200);
    }
    const deactivated = await prisma.user.findUniqueOrThrow({ where: { email: `${prefix}4@example.com` } });
    await prisma.user.update({ where: { id: deactivated.id }, data: { deactivatedAt: new Date() } });

    const prefixPage = await listUsers(`emailPrefix=${encodeURIComponent(prefix)}&state=active`);
    expect(prefixPage.status).toBe(200);
    expect(prefixPage.body.items).toHaveLength(4);
    for (const item of prefixPage.body.items) expect(item.email).toMatch(new RegExp(`^${prefix}`));

    const deactivatedPage = await listUsers(`emailPrefix=${encodeURIComponent(prefix)}&state=deactivated`);
    expect(deactivatedPage.body.items.map((item: { id: string }) => item.id)).toEqual([deactivated.id]);

    const first = await listUsers(`emailPrefix=${encodeURIComponent(prefix)}&limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await listUsers(
      `emailPrefix=${encodeURIComponent(prefix)}&limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(2);
    expect(second.body.nextCursor).toBeTruthy();

    const third = await listUsers(
      `emailPrefix=${encodeURIComponent(prefix)}&limit=2&cursor=${encodeURIComponent(second.body.nextCursor as string)}`,
    );
    expect(third.status).toBe(200);
    expect(third.body.items).toHaveLength(1);
    expect(third.body.nextCursor).toBeNull();

    const seen = new Set([
      ...first.body.items.map((item: { id: string }) => item.id),
      ...second.body.items.map((item: { id: string }) => item.id),
      ...third.body.items.map((item: { id: string }) => item.id),
    ]);
    expect(seen.size).toBe(5);

    expect((await listUsers('cursor=not-a-cursor')).status).toBe(400);
  });

  it('lists pending invites without token hashes and revokes one so it cannot be redeemed', async () => {
    const invitee = `revoke-me-${runId}@example.com`;
    const created = await createInvite(invitee);
    expect(created.status).toBe(201);

    const pending = await request(app)
      .get('/admin/invites?status=pending&limit=200')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(pending.status).toBe(200);
    const listed = pending.body.items.find((item: { id: string }) => item.id === (created.body.id as string));
    expect(listed).toMatchObject({ email: invitee, status: 'pending', revokedAt: null });
    expect(listed.tokenHash).toBeUndefined();
    expect(JSON.stringify(pending.body)).not.toContain('tokenHash');

    const revoked = await request(app)
      .delete(`/admin/invites/${created.body.id as string}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.alreadyRevoked).toBe(false);
    expect(revoked.body.invite.status).toBe('revoked');

    // Redemption now fails and creates no account.
    const redeemed = await request(app)
      .post('/auth/signup-with-invite')
      .send({ token: created.body.token as string, email: invitee, password: PASSWORD });
    expect(redeemed.status).toBe(400);
    expect(await prisma.user.count({ where: { email: invitee } })).toBe(0);

    // Revoking again is idempotent and writes no second audit event.
    const again = await request(app)
      .delete(`/admin/invites/${created.body.id as string}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(again.status).toBe(200);
    expect(again.body.alreadyRevoked).toBe(true);

    const auditRows = await prisma.auditEvent.findMany({
      where: { entityType: 'AdminInvite', entityId: created.body.id as string, action: 'admin_invite.revoked' },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.actorUserId).toBe(adminId);
    // No address in the audit metadata.
    expect(JSON.stringify(auditRows[0]!.metadata)).not.toContain(invitee);

    const revokedList = await request(app)
      .get('/admin/invites?status=revoked&limit=200')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(revokedList.status).toBe(200);
    expect(revokedList.body.items.map((item: { id: string }) => item.id)).toContain(created.body.id);

    // An already-redeemed invite is not revocable: 409, not a silent success.
    const redeemable = `already-redeemed-${runId}@example.com`;
    const second = await createInvite(redeemable);
    expect(second.status).toBe(201);
    const signup = await request(app)
      .post('/auth/signup-with-invite')
      .send({ token: second.body.token as string, email: redeemable, password: PASSWORD });
    expect(signup.status).toBe(200);

    const refused = await request(app)
      .delete(`/admin/invites/${second.body.id as string}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(refused.status).toBe(409);

    const redeemedList = await request(app)
      .get('/admin/invites?status=redeemed&limit=200')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(redeemedList.body.items.map((item: { id: string }) => item.id)).toContain(second.body.id);
  });

  it('has exactly one winner when revoke races redemption', async () => {
    const invitee = `race-${runId}@example.com`;
    const created = await createInvite(invitee);
    expect(created.status).toBe(201);

    const [revoke, redeem] = await Promise.all([
      request(app)
        .delete(`/admin/invites/${created.body.id as string}`)
        .set('Authorization', `Bearer ${adminToken}`),
      request(app)
        .post('/auth/signup-with-invite')
        .send({ token: created.body.token as string, email: invitee, password: PASSWORD }),
    ]);

    const revokedWon = revoke.status === 200;
    const redeemedWon = redeem.status === 200;
    // Exactly one path wins; a revoked invite is never redeemable and a
    // redeemed invite is never revocable.
    expect(revokedWon !== redeemedWon).toBe(true);
    if (revokedWon) {
      expect(redeem.status).toBe(400);
      expect(await prisma.user.count({ where: { email: invitee } })).toBe(0);
    } else {
      expect(revoke.status).toBe(409);
      expect(await prisma.user.count({ where: { email: invitee } })).toBe(1);
    }
  });
});
