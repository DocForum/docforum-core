// Authenticated password change (Phase 8, issue #270) — integration test.
// Verifies:
// 1. Re-authentication via throttled confirmPassword helper
// 2. Caller's own session is preserved while other sessions are revoked
// 3. User tokenVersion is bumped
// 4. AuditEvent is recorded without password material
// 5. Deactivated accounts and invalid passwords are rejected
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

process.env.DATABASE_URL = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-pwdchange-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
  initdbFlags: ['--encoding=UTF8'],
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;

function cookieFrom(res: request.Response): string {
  const header = res.headers['set-cookie']?.[0];
  if (!header) throw new Error('no set-cookie header');
  return header.split(';')[0];
}

describe('POST /auth/password (Phase 8, issue #270)', () => {
  let app: App;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;

  const initialPassword = 'Initial-Secure-Password-1';
  const newValidPassword = 'Brand-New-Secure-Password-2';

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');

    execFileSync(process.execPath, [path.join(BACKEND_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    const [appModule, dbModule] = await Promise.all([
      import('../../src/app.js'),
      import('../../src/db/prisma-client.js'),
    ]);
    app = appModule.createApp();
    prisma = dbModule.prisma;
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore temporary directory cleanup failure on Windows
    }
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .post('/auth/password')
      .send({ currentPassword: initialPassword, newPassword: newValidPassword });
    expect(res.status).toBe(401);
  });

  it('rejects requests with incorrect currentPassword with 401', async () => {
    // Signup user
    const userEmail = `wrong-curr-${runId}@example.com`;
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email: userEmail, password: initialPassword, fullName: 'Wrong Password Tester' });
    expect(signupRes.status).toBe(200);

    const token = signupRes.body.accessToken;
    expect(token).toBeDefined();

    const changeRes = await request(app)
      .post('/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'completely-wrong-password', newPassword: newValidPassword });

    expect([401, 403]).toContain(changeRes.status);
    expect(changeRes.body.message).toMatch(/invalid|incorrect|failed/i);
  });

  it('rejects when newPassword is equal to currentPassword with 400', async () => {
    const userEmail = `same-pwd-${runId}@example.com`;
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email: userEmail, password: initialPassword, fullName: 'Same Password Tester' });
    expect(signupRes.status).toBe(200);

    const token = signupRes.body.accessToken;

    const changeRes = await request(app)
      .post('/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: initialPassword, newPassword: initialPassword });

    expect(changeRes.status).toBe(400);
    expect(changeRes.body.code).toBe('PASSWORD_UNCHANGED');
  });

  it('rejects when newPassword violates password constraints (too short, > 72 bytes, breached)', async () => {
    const userEmail = `strength-${runId}@example.com`;
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email: userEmail, password: initialPassword, fullName: 'Strength Tester' });
    const token = signupRes.body.accessToken;

    // Too short
    const shortRes = await request(app)
      .post('/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: initialPassword, newPassword: 'short' });
    expect(shortRes.status).toBe(400);
    expect(shortRes.body.code).toBe('PASSWORD_TOO_SHORT');

    // Commonly breached
    const breachedRes = await request(app)
      .post('/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: initialPassword, newPassword: 'password' });
    expect(breachedRes.status).toBe(400);
    expect(breachedRes.body.code).toBe('PASSWORD_COMMONLY_BREACHED');

    // Exceeds 72 bytes
    const longRes = await request(app)
      .post('/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: initialPassword, newPassword: '€'.repeat(25) });
    expect(longRes.status).toBe(400);
    expect(longRes.body.code).toBe('PASSWORD_TOO_LONG');
  });

  it('rejects password change on deactivated accounts', async () => {
    const userEmail = `deactivated-${runId}@example.com`;
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email: userEmail, password: initialPassword, fullName: 'Deactivated Tester' });
    const token = signupRes.body.accessToken;
    const userId = signupRes.body.user.id;

    // Deactivate user in DB
    await prisma.user.update({
      where: { id: userId },
      data: { deactivatedAt: new Date() },
    });

    const res = await request(app)
      .post('/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: initialPassword, newPassword: newValidPassword });

    expect([401, 403]).toContain(res.status);
  });

  it('successfully changes password: preserves caller session, revokes others, bumps tokenVersion, and writes audit event', async () => {
    const userEmail = `success-${runId}@example.com`;
    // 1. Signup creates first session (Session 1)
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email: userEmail, password: initialPassword, fullName: 'Success Tester' });
    expect(signupRes.status).toBe(200);
    const session1Cookie = cookieFrom(signupRes);
    const session1Csrf = signupRes.body.csrfToken as string;
    const userId = signupRes.body.user.id;

    // 2. Second login creates Session 2
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: userEmail, password: initialPassword });
    expect(loginRes.status).toBe(200);
    const session2Cookie = cookieFrom(loginRes);
    const session2Token = loginRes.body.accessToken;

    // Check we have at least 2 active sessions in DB
    const initialSessions = await prisma.refreshSession.findMany({
      where: { userId, revokedAt: null },
    });
    expect(initialSessions.length).toBeGreaterThanOrEqual(2);

    const initialUser = await prisma.user.findUnique({ where: { id: userId } });
    const initialTokenVersion = initialUser?.tokenVersion ?? 0;

    // 3. Perform password change using Session 2
    const changeRes = await request(app)
      .post('/auth/password')
      .set('Authorization', `Bearer ${session2Token}`)
      .set('Cookie', session2Cookie)
      .send({ currentPassword: initialPassword, newPassword: newValidPassword });

    expect(changeRes.status).toBe(200);
    expect(changeRes.body.message).toMatch(/updated|success/i);
    // The caller gets a fresh pair back: the bump invalidated the old access
    // and CSRF tokens too, so a new cookie alone would not keep it signed in.
    expect(changeRes.body.accessToken).toBeDefined();
    expect(changeRes.body.csrfToken).toBeDefined();
    const callerCookie = cookieFrom(changeRes);
    const callerCsrf = changeRes.body.csrfToken as string;

    // 4. Verify user tokenVersion was bumped
    const updatedUser = await prisma.user.findUnique({ where: { id: userId } });
    expect(updatedUser?.tokenVersion).toBe(initialTokenVersion + 1);

    // 5. Verify other sessions were revoked with reason 'password_changed'
    const revokedSessions = await prisma.refreshSession.findMany({
      where: { userId, revokedAt: { not: null } },
    });
    expect(revokedSessions.length).toBeGreaterThan(0);
    const revokedForPwd = revokedSessions.filter((s) => s.revokedReason === 'password_changed');
    expect(revokedForPwd.length).toBeGreaterThan(0);

    // 6. Verify caller's session is still active
    const activeSessions = await prisma.refreshSession.findMany({
      where: { userId, revokedAt: null },
    });
    expect(activeSessions.length).toBe(1);

    // Verify session 1's refresh token is rejected
    const session1Refresh = await request(app)
      .post('/auth/refresh')
      .set('Cookie', session1Cookie)
      .set('X-CSRF-Token', session1Csrf);
    expect(session1Refresh.status).toBe(401);

    // The re-issued pair keeps the caller signed in: the session it called
    // from still refreshes, with the new tokenVersion and CSRF token.
    const callerRefresh = await request(app)
      .post('/auth/refresh')
      .set('Cookie', callerCookie)
      .set('X-CSRF-Token', callerCsrf);
    expect(callerRefresh.status).toBe(200);
    expect(callerRefresh.body.sessionId).toBe(changeRes.body.sessionId);

    // 7. Verify an AuditEvent was written without password material
    const auditEvents = await prisma.auditEvent.findMany({
      where: { entityId: userId, action: 'user.password_changed' },
    });
    expect(auditEvents.length).toBe(1);
    const audit = auditEvents[0];
    const metadataStr = JSON.stringify(audit.metadata || {});
    expect(metadataStr).not.toContain(initialPassword);
    expect(metadataStr).not.toContain(newValidPassword);

    // 8. Verify old password no longer works for login
    const oldLoginRes = await request(app)
      .post('/auth/login')
      .send({ email: userEmail, password: initialPassword });
    expect(oldLoginRes.status).toBe(401);

    // 9. Verify new password succeeds for login
    const newLoginRes = await request(app)
      .post('/auth/login')
      .send({ email: userEmail, password: newValidPassword });
    expect(newLoginRes.status).toBe(200);
  });
});
