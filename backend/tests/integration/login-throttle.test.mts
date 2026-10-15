// Integration tests for login brute-force protection (Phase 8, issue #35):
// DB-backed, atomically-counted, per-account and per-IP throttling with
// exponential backoff and a temporary lock, plus the admin clear path and
// the cleanup job. Self-contained embedded Postgres, same pattern as
// booking.test.mts — own port (5436) so it can run alongside the other
// integration files.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5436;
const runId = Date.now();
const PASSWORD = 'longenough123';

// Short windows/policies so the tests don't wait real minutes. Set before
// src/config loads (module import happens in beforeAll).
process.env.LOGIN_THROTTLE_WINDOW_SECONDS = '900';
process.env.LOGIN_THROTTLE_BACKOFF_AFTER = '3';
process.env.LOGIN_THROTTLE_BACKOFF_BASE_SECONDS = '1';
process.env.LOGIN_THROTTLE_BACKOFF_MAX_SECONDS = '5';
process.env.LOGIN_THROTTLE_LOCK_AFTER = '5';
process.env.LOGIN_THROTTLE_LOCK_SECONDS = '60';
process.env.LOGIN_THROTTLE_PRUNE_AFTER_SECONDS = '3600';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-login-throttle-pg-'));
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
type AuthServices = typeof import('../../src/modules/auth/services/index.js');

describe('login brute-force protection', () => {
  let app: App;
  let prisma: Prisma;
  let authServices: AuthServices;
  let adminToken: string;

  function login(email: string, password = PASSWORD) {
    return request(app).post('/auth/login').send({ email, password });
  }

  function attemptsFor(scope: string, key: string) {
    return prisma.loginAttempt.findMany({ where: { scope, key } });
  }

  async function resetThrottleState() {
    await prisma.loginAttempt.deleteMany();
  }

  async function signupPatient(label: string) {
    const email = `throttle-${label}-${runId}@example.com`;
    const res = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email, password: PASSWORD, fullName: `Throttle ${label}` });
    expect(res.status).toBe(200);
    return email;
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

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    authServices = await import('../../src/modules/auth/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    // An admin, for the clear-lock endpoint. Promote-then-login, the same
    // route ADR 0003's runbook takes.
    const adminEmail = await signupPatient('admin');
    await prisma.user.update({ where: { email: adminEmail }, data: { role: 'admin' } });
    const adminLogin = await login(adminEmail);
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.accessToken as string;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('counts concurrent failed attempts atomically — no lost updates', async () => {
    await resetThrottleState();
    const email = await signupPatient('concurrent');

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => login(email, 'wrong-password-here')),
    );

    // Every attempt was either a plain rejection or a throttled one — never
    // a success — and each was recorded exactly once.
    expect(responses.every((res) => res.status === 401 || res.status === 429)).toBe(true);

    const emailBuckets = await attemptsFor('email', email.toLowerCase());
    expect(emailBuckets).toHaveLength(1);
    expect(emailBuckets[0]!.failedCount).toBe(8);

    const ipBuckets = await attemptsFor('ip', '127.0.0.1');
    expect(ipBuckets).toHaveLength(1);
    expect(ipBuckets[0]!.failedCount).toBe(8);
  });

  it('locks the account after the threshold, refuses the correct password with Retry-After, and an admin can clear it', async () => {
    const email = await signupPatient('locked');
    await resetThrottleState();

    for (let i = 0; i < 5; i += 1) {
      await login(email, 'wrong-password-here');
    }

    const emailBucket = (await attemptsFor('email', email.toLowerCase()))[0]!;
    expect(emailBucket.failedCount).toBe(5);
    expect(emailBucket.lockUntil).not.toBeNull();
    expect(emailBucket.lockUntil!.getTime()).toBeGreaterThan(Date.now());

    // The correct password is refused too — the gate runs before the
    // password hash is compared, which is the point of a lock.
    const locked = await login(email);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(locked.body.message).toMatch(/Too many failed login attempts/);

    // A refused attempt is still recorded (the gate can't distinguish a
    // correct from a wrong password), but it must not push the lock's
    // deadline out — otherwise hammering an account would lock the real
    // owner out indefinitely.
    const stillLocked = await login(email, 'another-wrong-one');
    expect(stillLocked.status).toBe(429);
    const afterRefusals = (await attemptsFor('email', email.toLowerCase()))[0]!;
    expect(afterRefusals.failedCount).toBe(7);
    expect(afterRefusals.lockUntil!.getTime()).toBe(emailBucket.lockUntil!.getTime());

    // Admin escape hatch: the caller supplies both buckets, since a lock
    // taken out via this IP would otherwise keep blocking the account.
    const cleared = await request(app)
      .post('/auth/login-attempts/clear')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email, ip: '127.0.0.1' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.cleared).toBe(2);

    const backIn = await login(email);
    expect(backIn.status).toBe(200);
  });

  it('requires an admin to clear a lock', async () => {
    await resetThrottleState();
    const email = await signupPatient('clear-authz');
    const patientLogin = await login(email);
    expect(patientLogin.status).toBe(200);

    const asPatient = await request(app)
      .post('/auth/login-attempts/clear')
      .set('Authorization', `Bearer ${patientLogin.body.accessToken as string}`)
      .send({ email });

    expect(asPatient.status).toBe(403);
    expect(await attemptsFor('email', email.toLowerCase())).toHaveLength(0);
  });

  it('throttles an unknown address exactly like a known one (no account-existence leak)', async () => {
    const known = await signupPatient('known');

    await resetThrottleState();
    const knownStatuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      knownStatuses.push((await login(known, 'wrong-password-here')).status);
    }

    await resetThrottleState();
    const unknownEmail = `nobody-${runId}@example.com`;
    const unknownStatuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      unknownStatuses.push((await login(unknownEmail, 'wrong-password-here')).status);
    }

    expect(unknownStatuses).toEqual(knownStatuses);
    expect(knownStatuses.slice(0, 2)).toEqual([401, 401]); // below the backoff threshold
    expect(knownStatuses[knownStatuses.length - 1]).toBe(429);

    // The throttled response names neither the address nor its existence.
    const throttled = await login(unknownEmail, 'wrong-password-here');
    expect(throttled.status).toBe(429);
    expect(throttled.body.message).not.toMatch(/not found|no account|does not exist/i);
    expect(JSON.stringify(throttled.body)).not.toContain(unknownEmail);
  });

  it('throttles by IP across different accounts', async () => {
    await resetThrottleState();
    const victim = await signupPatient('ip-victim');

    // Five failures spread over five *different* accounts from one IP: no
    // single account is anywhere near its own lock threshold, but the IP
    // bucket is.
    for (let i = 0; i < 5; i += 1) {
      await login(`ip-rotation-${i}-${runId}@example.com`, 'wrong-password-here');
    }

    const ipBucket = (await attemptsFor('ip', '127.0.0.1'))[0]!;
    expect(ipBucket.failedCount).toBe(5);
    expect(ipBucket.lockUntil).not.toBeNull();

    const blocked = await login(victim);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // The refusal came from the IP bucket, not the account: the victim's own
    // bucket has a single (correct!) attempt recorded and no lock, so it is
    // nowhere near its own threshold.
    const emailBucket = (await attemptsFor('email', victim.toLowerCase()))[0]!;
    expect(emailBucket.failedCount).toBe(1);
    expect(emailBucket.lockUntil).toBeNull();
  });

  it('resets the per-account counter on a successful login, leaving the IP bucket alone', async () => {
    await resetThrottleState();
    const email = await signupPatient('reset');

    await login(email, 'wrong-password-here');
    await login(email, 'wrong-password-here');
    expect((await attemptsFor('email', email.toLowerCase()))[0]!.failedCount).toBe(2);

    const success = await login(email);
    expect(success.status).toBe(200);

    expect(await attemptsFor('email', email.toLowerCase())).toHaveLength(0);
    expect((await attemptsFor('ip', '127.0.0.1'))[0]!.failedCount).toBe(2);
  });

  it('prunes buckets whose last failure is older than the retention window', async () => {
    await resetThrottleState();
    const email = await signupPatient('prune');

    await login(email, 'wrong-password-here');
    expect(await prisma.loginAttempt.count()).toBe(2); // email + ip

    await prisma.loginAttempt.updateMany({
      data: { lastFailedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }, // older than the 1h retention
    });

    const removed = await authServices.pruneLoginAttempts();
    expect(removed).toBe(2);
    expect(await prisma.loginAttempt.count()).toBe(0);
  });
});
