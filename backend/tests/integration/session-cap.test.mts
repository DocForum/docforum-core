// Active refresh-session cap (Phase 8, issue #278) — integration, against a
// real Postgres. Proves the cap is enforced atomically with session creation,
// that the evicted (least recently used) session's refresh token stops
// working, and that concurrent logins cannot leave the account above the cap.
//
// Self-contained like the other integration suites: throwaway Postgres on
// its own port (one port per file — vitest runs files in parallel).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

// Read by src/config/sections/sessions.ts at import time — set before the
// app module is imported so this suite runs with a small, observable cap.
process.env.MAX_ACTIVE_SESSIONS_PER_USER = '3';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5475;
const runId = Date.now();
const PASSWORD = 'longenough123';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-session-cap-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;

function refreshCookie(res: request.Response): string {
  const header = res.headers['set-cookie']?.[0];
  if (!header) throw new Error('no set-cookie header');
  return header.split(';')[0];
}

describe('active refresh-session cap', () => {
  let app: App;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let email: string;
  let signupCookie: string;
  let signupCsrf: string;

  function login() {
    return request(app).post('/auth/login').send({ email, password: PASSWORD });
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

    process.env.DATABASE_URL = databaseUrl;

    const [appModule, dbModule] = await Promise.all([
      import('../../src/app.js'),
      import('../../src/db/prisma-client.js'),
    ]);
    app = appModule.createApp();
    prisma = dbModule.prisma;

    email = `session-cap-${runId}@example.com`;
    const signup = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email, password: PASSWORD, fullName: 'Session Cap Patient' });
    expect(signup.status).toBe(200);
    signupCookie = refreshCookie(signup);
    signupCsrf = signup.body.csrfToken as string;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('leaves N sessions for N+1 logins and kills the evicted refresh token', async () => {
    const userId = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
    // beforeAll's signup is session 1; two logins fill the cap of 3.
    const second = await login();
    const third = await login();
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);

    // The 4th login evicts the least recently used session — the signup one.
    const signupSession = await prisma.refreshSession.findFirstOrThrow({
      where: { userId, revokedAt: null },
      orderBy: [{ lastUsedAt: 'asc' }, { createdAt: 'asc' }],
    });
    const fourth = await login();
    expect(fourth.status).toBe(200);

    const active = await prisma.refreshSession.findMany({ where: { userId, revokedAt: null } });
    expect(active).toHaveLength(3);

    const evicted = await prisma.refreshSession.findUniqueOrThrow({ where: { id: signupSession.id } });
    expect(evicted.revokedAt).not.toBeNull();
    expect(evicted.revokedReason).toBe('max_active_sessions');

    // The evicted refresh token no longer buys a new access token.
    const refused = await request(app)
      .post('/auth/refresh')
      .set('Cookie', signupCookie)
      .set('X-CSRF-Token', signupCsrf);
    expect(refused.status).toBe(401);

    // The session just issued is one of the survivors.
    const survivors = await request(app)
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${fourth.body.accessToken as string}`);
    expect(survivors.status).toBe(200);
    expect(survivors.body).toHaveLength(3);
    expect(survivors.body.map((item: { id: string }) => item.id)).toContain(fourth.body.sessionId);
  });

  it('holds the cap under concurrent logins', async () => {
    const userId = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;

    const results = await Promise.all(Array.from({ length: 8 }, () => login()));
    for (const result of results) expect(result.status).toBe(200);

    // Concurrent logins serialise on the per-user lock, so the cap holds
    // exactly rather than being temporarily exceeded.
    const active = await prisma.refreshSession.findMany({ where: { userId, revokedAt: null } });
    expect(active).toHaveLength(3);

    const over = await prisma.refreshSession.count({
      where: { userId, revokedAt: null },
    });
    expect(over).toBeLessThanOrEqual(3);

    // The session issued after the burst is the newest and survives — a
    // login never evicts itself.
    const afterBurst = await login();
    expect(afterBurst.status).toBe(200);
    const survivors = await prisma.refreshSession.findMany({ where: { userId, revokedAt: null } });
    expect(survivors).toHaveLength(3);
    expect(survivors.map((session) => session.id)).toContain(afterBurst.body.sessionId);
  });
});
