// Integration tests for CSRF protection on the cookie-authenticated routes
// (Phase 8, issue #37). The point of these tests is that a forged
// cross-origin request *fails* while the legitimate cross-site web client
// still succeeds — the refresh cookie travels with `SameSite=None`, so the
// browser will happily attach it to a request any site causes.
//
// Self-contained embedded Postgres, own port (5437) so it runs alongside the
// other integration files.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5437;
const runId = Date.now();
const WEB_ORIGIN = 'http://localhost:5173'; // local-dev allowlist entry
const ATTACKER_ORIGIN = 'https://evil.example';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-csrf-pg-'));
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

function cookiePair(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const match = list.find((cookie) => cookie.startsWith(`${name}=`));
  return match ? match.split(';')[0]! : null;
}

describe('CSRF protection for cookie-authenticated routes', () => {
  let app: App;
  let prisma: Prisma;

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
    app = appModule.createApp();
    prisma = dbModule.prisma;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function loginFresh(label: string) {
    const email = `csrf-${label}-${runId}@example.com`;
    const res = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email, password: 'longenough123', fullName: `CSRF ${label}` });
    expect(res.status).toBe(200);
    return {
      email,
      accessToken: res.body.accessToken as string,
      csrfToken: res.body.csrfToken as string,
      cookie: cookiePair(res, 'docforum_refresh')!,
      raw: res,
    };
  }

  it('returns the CSRF token in the body, never as a JS-readable cookie', async () => {
    const { csrfToken, raw } = await loginFresh('shape');

    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cookies = (raw.headers['set-cookie'] as unknown) as string[];
    const list = Array.isArray(cookies) ? cookies : [cookies];
    const refreshCookie = list.find((cookie) => cookie.startsWith('docforum_refresh='))!;
    expect(refreshCookie).toMatch(/HttpOnly/i);
    // No second, readable cookie: a cross-site frontend couldn't read one
    // anyway (see middleware/csrf.ts), so the token lives in the body.
    expect(list.filter((cookie) => !cookie.startsWith('docforum_refresh='))).toHaveLength(0);
  });

  it('rejects a forged cross-origin refresh and a missing/wrong CSRF token', async () => {
    const { csrfToken, cookie } = await loginFresh('forged');

    // A page on the attacker's origin gets the cookie attached by the
    // browser (SameSite=None) but cannot read the token to echo it.
    const forged = await request(app)
      .post('/auth/refresh')
      .set('Origin', ATTACKER_ORIGIN)
      .set('Cookie', cookie);
    expect(forged.status).toBe(403);
    expect(forged.headers['access-control-allow-origin']).toBeUndefined();

    // Hiding the Origin doesn't help: the token is still required.
    const noOriginNoToken = await request(app).post('/auth/refresh').set('Cookie', cookie);
    expect(noOriginNoToken.status).toBe(403);

    const wrongToken = await request(app)
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'not-the-session-token');
    expect(wrongToken.status).toBe(403);

    // The session is untouched by the refusals — the still-valid token works.
    const legitimate = await request(app)
      .post('/auth/refresh')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken);
    expect(legitimate.status).toBe(200);
  });

  it('accepts the legitimate cross-site web client and rotates the CSRF token', async () => {
    const { csrfToken, cookie } = await loginFresh('legit');

    const refreshed = await request(app)
      .post('/auth/refresh')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken);

    expect(refreshed.status).toBe(200);
    expect(refreshed.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(refreshed.body.accessToken).toBeTruthy();

    const rotated = refreshed.body.csrfToken as string;
    expect(rotated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated).not.toBe(csrfToken);

    // The rotated token is the one that works from here on; the old token is
    // no longer accepted, because it belonged to the previous refresh token.
    const newCookie = cookiePair(refreshed, 'docforum_refresh')!;
    const withOldToken = await request(app)
      .post('/auth/refresh')
      .set('Cookie', newCookie)
      .set('X-CSRF-Token', csrfToken);
    expect(withOldToken.status).toBe(403);

    const withNewToken = await request(app)
      .post('/auth/refresh')
      .set('Cookie', newCookie)
      .set('X-CSRF-Token', rotated);
    expect(withNewToken.status).toBe(200);
  });

  it('rejects a refresh token minted before the CSRF claim existed', async () => {
    const { email } = await loginFresh('legacy');
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });

    // What a deployed instance would have issued before this change.
    const legacyToken = jwt.sign({ sub: user.id, role: 'patient' }, 'test-refresh-secret', { expiresIn: '1h' });

    const res = await request(app)
      .post('/auth/refresh')
      .set('Cookie', `docforum_refresh=${legacyToken}`)
      .set('X-CSRF-Token', 'anything');
    expect(res.status).toBe(403);
  });

  it('applies the same policy to logout, and only clears the cookie when allowed', async () => {
    const { csrfToken, cookie } = await loginFresh('logout');

    const forged = await request(app).post('/auth/logout').set('Origin', ATTACKER_ORIGIN).set('Cookie', cookie);
    expect(forged.status).toBe(403);
    // Nothing cleared: a forged logout must not succeed.
    expect(cookiePair(forged, 'docforum_refresh')).toBeNull();

    const noToken = await request(app).post('/auth/logout').set('Origin', WEB_ORIGIN).set('Cookie', cookie);
    expect(noToken.status).toBe(403);

    const real = await request(app)
      .post('/auth/logout')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken);
    expect(real.status).toBe(204);
    expect(cookiePair(real, 'docforum_refresh')).toMatch(/docforum_refresh=;|docforum_refresh=$/);
  });

  it('allows a non-browser client with no Origin header that presents the token', async () => {
    // Deliberate, documented policy: `Origin` is absent for curl and
    // server-to-server callers, so it can't be the only gate — but the token
    // is still required, so an attacker's page can't win by omitting Origin.
    const { csrfToken, cookie } = await loginFresh('no-origin');

    const res = await request(app)
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken);
    expect(res.status).toBe(200);
  });

  it('rejects a malformed refresh cookie before any CSRF consideration', async () => {
    const res = await request(app)
      .post('/auth/refresh')
      .set('Cookie', 'docforum_refresh=not-a-jwt')
      .set('X-CSRF-Token', 'anything');
    expect(res.status).toBe(401);
  });
});
