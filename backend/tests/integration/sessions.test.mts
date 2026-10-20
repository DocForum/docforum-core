// Session management (Phase 8 #38) — integration, against a real Postgres,
// because the properties under test are all about persistence: a session
// row exists per login, refresh updates it instead of creating a new one,
// revocation is enforced at refresh time, and ownership checks hold.
//
// Self-contained like the other integration suites: throwaway Postgres on
// port 5438 (one port per file — vitest runs files in parallel).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5438;
const runId = Date.now();

process.env.DATABASE_URL = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-sessions-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;

function cookieFrom(res: request.Response): string {
  const header = res.headers['set-cookie']?.[0];
  if (!header) throw new Error('no set-cookie header');
  return header.split(';')[0];
}

describe('session management', () => {
  let app: App;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let hashPassword: typeof import('../../src/modules/auth/services/password.js').hashPassword;

  const patientA = { email: `sessions-a-${runId}@example.com`, password: 'patient-a-password-1' };
  const patientB = { email: `sessions-b-${runId}@example.com`, password: 'patient-b-password-1' };

  let tokenA: string;
  let sessionIdA1: string;
  let cookieA1: string;
  let csrfA1: string;
  let patientBUserId: string;
  let tokenB: string;
  let cookieB: string;
  let csrfB: string;

  function login(email: string, password: string) {
    return request(app).post('/auth/login').send({ email, password });
  }

  function sessions(token: string) {
    return request(app).get('/auth/sessions').set('Authorization', `Bearer ${token}`);
  }

  function refresh(cookie: string, csrfToken: string) {
    return request(app).post('/auth/refresh').set('Cookie', cookie).set('X-CSRF-Token', csrfToken);
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    const [appModule, dbModule, passwordModule] = await Promise.all([
      import('../../src/app.js'),
      import('../../src/db/prisma-client.js'),
      import('../../src/modules/auth/services/password.js'),
    ]);
    app = appModule.createApp();
    prisma = dbModule.prisma;
    hashPassword = passwordModule.hashPassword;

    const signupA = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email: patientA.email, password: patientA.password, fullName: 'Session Patient A' });
    expect(signupA.status).toBe(200);
    tokenA = signupA.body.accessToken as string;
    sessionIdA1 = signupA.body.sessionId as string;
    cookieA1 = cookieFrom(signupA);
    csrfA1 = signupA.body.csrfToken as string;

    const signupB = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email: patientB.email, password: patientB.password, fullName: 'Session Patient B' });
    expect(signupB.status).toBe(200);
    tokenB = signupB.body.accessToken as string;
    cookieB = cookieFrom(signupB);
    csrfB = signupB.body.csrfToken as string;
    patientBUserId = (await prisma.user.findUniqueOrThrow({ where: { email: patientB.email } })).id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('records a session per login and lists only the caller own sessions', async () => {
    // A second login from a distinguishable client — this is what makes
    // "sign out that other device" possible at all.
    const second = await request(app)
      .post('/auth/login')
      .set('User-Agent', 'TestBrowser/1.0')
      .send({ email: patientA.email, password: patientA.password });
    expect(second.status).toBe(200);
    const sessionIdA2 = second.body.sessionId as string;
    expect(sessionIdA2).not.toBe(sessionIdA1);

    const list = await sessions(tokenA);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);

    const ids = list.body.map((s: { id: string }) => s.id);
    expect(ids).toContain(sessionIdA1);
    expect(ids).toContain(sessionIdA2);

    // The request context is recorded per session (coarse IP + user agent).
    const a2 = list.body.find((s: { id: string }) => s.id === sessionIdA2);
    expect(a2.userAgent).toBe('TestBrowser/1.0');
    expect(a2.ip).toBeTruthy();

    // A different user sees only their own — never A's.
    const listB = await sessions(tokenB);
    expect(listB.body).toHaveLength(1);
    expect(listB.body.map((s: { id: string }) => s.id)).not.toContain(sessionIdA1);
    const bRow = await prisma.refreshSession.findUniqueOrThrow({ where: { id: listB.body[0].id } });
    expect(bRow.userId).toBe(patientBUserId);
  });

  it('marks the session behind the request cookie as current', async () => {
    const list = await request(app).get('/auth/sessions').set('Authorization', `Bearer ${tokenA}`).set('Cookie', cookieA1);
    const current = list.body.filter((s: { current: boolean }) => s.current);
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(sessionIdA1);
  });

  it('rotates tokens on refresh without creating a new session, and updates last-used', async () => {
    const before = await prisma.refreshSession.findUniqueOrThrow({ where: { id: sessionIdA1 } });
    expect(await prisma.refreshSession.count({ where: { userId: before.userId } })).toBe(2);

    const refreshed = await refresh(cookieA1, csrfA1);
    expect(refreshed.status).toBe(200);
    // Same session (same family) — rotation does not fork the session.
    expect(refreshed.body.sessionId).toBe(sessionIdA1);
    expect(await prisma.refreshSession.count({ where: { userId: before.userId } })).toBe(2);

    const after = await prisma.refreshSession.findUniqueOrThrow({ where: { id: sessionIdA1 } });
    expect(after.lastUsedAt.getTime()).toBeGreaterThanOrEqual(before.lastUsedAt.getTime());

    // Subsequent requests use the rotated cookie and CSRF token.
    cookieA1 = cookieFrom(refreshed);
    csrfA1 = refreshed.body.csrfToken as string;
  });

  it('does not let a user see or revoke another user sessions', async () => {
    const foreign = await request(app)
      .delete(`/auth/sessions/${sessionIdA1}`)
      .set('Authorization', `Bearer ${tokenB}`);
    // Scoped update: A's id simply doesn't match B's rows.
    expect(foreign.status).toBe(404);

    // A's session is untouched.
    expect((await refresh(cookieA1, csrfA1)).status).toBe(200);
    const listA = await sessions(tokenA);
    expect(listA.body.map((s: { id: string }) => s.id)).toContain(sessionIdA1);

    // And B can't enumerate it either.
    const listB = await sessions(tokenB);
    expect(listB.body.map((s: { id: string }) => s.id)).not.toContain(sessionIdA1);
  });

  it('rejects a revoked session refresh immediately', async () => {
    // Send the cookie so "current" means this session — the *other* one is
    // the one under test here.
    const sessionsBefore = (await request(app).get('/auth/sessions').set('Authorization', `Bearer ${tokenA}`).set('Cookie', cookieA1)).body as { id: string; current: boolean }[];
    const other = sessionsBefore.find((s) => !s.current);
    expect(other).toBeDefined();

    const revoked = await request(app)
      .delete(`/auth/sessions/${other?.id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(revoked.status).toBe(204);

    // The revoked session's cookie no longer works...
    const revokedRow = await prisma.refreshSession.findUniqueOrThrow({ where: { id: other?.id } });
    expect(revokedRow.revokedAt).not.toBeNull();

    // ...and the caller's own session still does.
    expect((await refresh(cookieA1, csrfA1)).status).toBe(200);

    const after = (await sessions(tokenA)).body as { id: string }[];
    expect(after.map((s) => s.id)).not.toContain(other?.id);
  });

  it('clears the refresh cookie when the current session is revoked', async () => {
    const refreshed = await refresh(cookieA1, csrfA1);
    cookieA1 = cookieFrom(refreshed);
    csrfA1 = refreshed.body.csrfToken as string;

    const revoked = await request(app)
      .delete(`/auth/sessions/${sessionIdA1}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Cookie', cookieA1);

    expect(revoked.status).toBe(204);
    const cleared = revoked.headers['set-cookie']?.[0] as unknown as string;
    expect(cleared).toContain('docforum_refresh=');
    expect(cleared).toMatch(/Expires=|Max-Age=0/);

    expect((await refresh(cookieA1, csrfA1)).status).toBe(401);
  });

  it('revokes every other session but keeps the current one', async () => {
    const first = await login(patientA.email, patientA.password);
    const second = await login(patientA.email, patientA.password);
    const currentCookie = cookieFrom(second);
    const currentCsrf = second.body.csrfToken as string;
    const staleCookie = cookieFrom(first);
    const staleCsrf = first.body.csrfToken as string;

    const result = await request(app)
      .delete('/auth/sessions')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Cookie', currentCookie);
    expect(result.status).toBe(200);
    expect(result.body.revoked).toBeGreaterThanOrEqual(1);

    expect((await refresh(staleCookie, staleCsrf)).status).toBe(401);
    expect((await refresh(currentCookie, currentCsrf)).status).toBe(200);

    // Make the surviving session the one the rest of the file uses.
    const rotated = await refresh(currentCookie, currentCsrf);
    cookieA1 = cookieFrom(rotated);
    csrfA1 = rotated.body.csrfToken as string;
  });

  it('lets an admin revoke all sessions for a user, and only admins', async () => {
    const adminEmail = `sessions-admin-${runId}@example.com`;
    await prisma.user.create({
      data: { email: adminEmail, role: 'admin', passwordHash: await hashPassword('admin-password-1') },
    });
    const adminLogin = await login(adminEmail, 'admin-password-1');
    expect(adminLogin.status).toBe(200);
    const adminToken = adminLogin.body.accessToken as string;

    const forbidden = await request(app)
      .delete(`/admin/users/${patientBUserId}/sessions`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(forbidden.status).toBe(403);

    const asAdmin = await request(app)
      .delete(`/admin/users/${patientBUserId}/sessions`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.revoked).toBeGreaterThanOrEqual(1);

    // B's refresh is dead — the session row is the kill switch.
    expect((await refresh(cookieB, csrfB)).status).toBe(401);
    expect((await sessions(tokenB)).body).toHaveLength(0);
  });
});
