// Password reset (Phase 8 #33) — integration, against a real Postgres,
// because the properties that matter here are DB-level ones: only the hash
// is stored, a token is single-use, a second request supersedes the first,
// and old refresh tokens die after a reset. A mocked repository would not
// prove any of that.
//
// Self-contained like booking.test.mts: throwaway Postgres on port 5449
// (distinct port per integration file — vitest runs files in parallel).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5449;
const runId = Date.now();

// Must be set before anything from src/ is imported: config/index.ts reads
// process.env at module load. A high per-IP limit keeps the per-email limit
// (the one under test) reachable from a single test-runner IP.
process.env.PASSWORD_RESET_REQUESTS_PER_IP_PER_HOUR = '1000';
process.env.PASSWORD_RESET_REQUESTS_PER_EMAIL_PER_HOUR = '3';
process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES = '30';
// vitest.config.mts points DATABASE_URL at booking.test.mts's cluster
// (5433); this file runs its own on 5449, so it has to say so before
// src/db/prisma-client.ts constructs the client at import time.
process.env.DATABASE_URL = 'postgresql://docforum:docforum@localhost:5449/docforum_test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-reset-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

const GENERIC_INVALID = 'This password reset link is invalid or has expired. Request a new one.';

type App = ReturnType<typeof import('../../src/app.js').createApp>;

describe('password reset', () => {
  let app: App;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let setNotificationChannel: typeof import('../../src/modules/notifications/services/index.js').setNotificationChannel;
  let resetRateLimits: typeof import('../../src/modules/auth/services/index.js').resetPasswordResetRateLimits;
  let sent: { to: string; subject: string; body: string }[];

  const email = `reset-${runId}@example.com`;
  const originalPassword = 'original-password-1';
  const newPassword = 'brand-new-password-2';

  /** The most recent reset link dispatched through the notifications
   * interface — this is the "console/dev adapter" seam, replaced by a spy. */
  function lastToken(): string {
    const last = sent.at(-1);
    if (!last) throw new Error('no notification was sent');
    const match = /token=([^\s]+)/.exec(last.body);
    if (!match) throw new Error('no token in notification body');
    return decodeURIComponent(match[1]);
  }

  function requestReset(targetEmail: string) {
    return request(app).post('/auth/password-reset/request').send({ email: targetEmail });
  }

  function confirmReset(token: string, password: string) {
    return request(app).post('/auth/password-reset/confirm').send({ token, newPassword: password });
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

    const [appModule, dbModule, notificationsModule, authModule] = await Promise.all([
      import('../../src/app.js'),
      import('../../src/db/prisma-client.js'),
      import('../../src/modules/notifications/services/index.js'),
      import('../../src/modules/auth/services/index.js'),
    ]);
    app = appModule.createApp();
    prisma = dbModule.prisma;
    setNotificationChannel = notificationsModule.setNotificationChannel;
    resetRateLimits = authModule.resetPasswordResetRateLimits;

    sent = [];
    setNotificationChannel({
      async send(message) {
        sent.push(message);
      },
    });

    const signup = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email, password: originalPassword, fullName: 'Reset Tester' });
    expect(signup.status).toBe(200);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // The rate limiters are module-level singletons (so the limit genuinely
  // holds across requests) — reset them so one test's requests can't make
  // the next test's first request a 429. The limit itself is exercised in
  // its own test below.
  beforeEach(() => {
    resetRateLimits();
  });

  it('answers identically for an unknown and a known email (no account-existence leak)', async () => {
    const before = sent.length;
    const unknown = await requestReset(`nobody-${runId}@example.com`);
    const known = await requestReset(email);

    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    // No account, no notification — and nothing in the response says so.
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)?.to).toBe(email);
  });

  it('stores only the SHA-256 hash of the token, never the raw token', async () => {
    expect((await requestReset(email)).status).toBe(202);
    const rawToken = lastToken();

    const rows = await prisma.passwordResetToken.findMany({ where: { userId: (await prisma.user.findUniqueOrThrow({ where: { email } })).id } });
    expect(rows.length).toBeGreaterThan(0);

    const expectedHash = createHash('sha256').update(rawToken).digest('hex');
    expect(rows.some((row) => row.tokenHash === expectedHash)).toBe(true);
    expect(rows.every((row) => row.tokenHash !== rawToken)).toBe(true);
  });

  it('resets the password and rejects reusing the same token', async () => {
    expect((await requestReset(email)).status).toBe(202);
    const rawToken = lastToken();

    const first = await confirmReset(rawToken, newPassword);
    expect(first.status).toBe(200);

    const reuse = await confirmReset(rawToken, 'yet-another-password-3');
    expect(reuse.status).toBe(400);
    expect(reuse.body.message).toBe(GENERIC_INVALID);

    // The new password is live, the old one is not.
    expect((await request(app).post('/auth/login').send({ email, password: newPassword })).status).toBe(200);
    expect((await request(app).post('/auth/login').send({ email, password: originalPassword })).status).toBe(401);
  });

  it('invalidates the previous token when a second reset is requested', async () => {
    expect((await requestReset(email)).status).toBe(202);
    const superseded = lastToken();
    expect((await requestReset(email)).status).toBe(202);
    const current = lastToken();

    const stale = await confirmReset(superseded, 'stale-token-password-1');
    expect(stale.status).toBe(400);
    expect(stale.body.message).toBe(GENERIC_INVALID);

    expect((await confirmReset(current, newPassword)).status).toBe(200);
  });

  it('rejects an expired token with the same generic error', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const rawToken = `expired-${runId}`;
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: createHash('sha256').update(rawToken).digest('hex'),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const res = await confirmReset(rawToken, 'expired-token-password-1');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(GENERIC_INVALID);
  });

  it('rejects a token that was never issued, with the same generic error', async () => {
    const res = await confirmReset('definitely-not-a-real-token', 'whatever-password-1');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(GENERIC_INVALID);
  });

  it('stops accepting refresh tokens issued before the reset', async () => {
    const login = await request(app).post('/auth/login').send({ email, password: newPassword });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie']?.[0] as unknown as string;
    const csrfToken = login.body.csrfToken as string;
    expect(cookie).toBeTruthy();
    expect(csrfToken).toBeTruthy();

    expect(
      (await request(app).post('/auth/refresh').set('Cookie', cookie).set('X-CSRF-Token', csrfToken)).status,
    ).toBe(200);

    expect((await requestReset(email)).status).toBe(202);
    expect((await confirmReset(lastToken(), newPassword)).status).toBe(200);

    // Same cookie, same token — now revoked by the tokenVersion bump.
    const afterReset = await request(app)
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken);
    expect(afterReset.status).toBe(401);
  });

  it('rate-limits requests per email', async () => {
    // 3 is the configured per-email limit (PASSWORD_RESET_REQUESTS_PER_EMAIL_PER_HOUR).
    const limitedEmail = `limited-${runId}@example.com`;
    expect((await requestReset(limitedEmail)).status).toBe(202);
    expect((await requestReset(limitedEmail)).status).toBe(202);
    expect((await requestReset(limitedEmail)).status).toBe(202);

    const tooMany = await requestReset(limitedEmail);
    expect(tooMany.status).toBe(429);
  });
});
