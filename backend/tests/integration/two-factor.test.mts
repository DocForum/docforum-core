// TOTP two-factor auth (Phase 8 #36) — integration, against a real
// Postgres: enrollment, the two-step login, the mfa_pending token's
// single-purpose scope, replay rejection, single-use recovery codes, the
// disable rule, and the admin-mandatory config flag.
//
// Self-contained like the other integration suites: throwaway Postgres on
// port 5450 (one port per file — vitest runs files in parallel).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5450;
const runId = Date.now();

// Set before importing anything from src/ — config/index.ts reads
// process.env at module load, and tokens.ts reads the 2FA TTL.
process.env.DATABASE_URL = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
process.env.REQUIRE_2FA_FOR_ADMIN = 'true';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-2fa-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;

describe('TOTP two-factor authentication', () => {
  let app: App;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let totpCodeAtStep: typeof import('../../src/modules/auth/services/totp.js').totpCodeAtStep;
  let timeStepFor: typeof import('../../src/modules/auth/services/totp.js').timeStepFor;
  let hashPassword: typeof import('../../src/modules/auth/services/password.js').hashPassword;

  const doctorEmail = `doctor-2fa-${runId}@example.com`;
  const password = 'doctor-password-1';
  let secret: string;
  let recoveryCodes: string[];

  function currentCode(offsetSteps = 0): string {
    return totpCodeAtStep(secret, timeStepFor(Date.now()) + offsetSteps);
  }

  function login(email = doctorEmail, pwd = password) {
    return request(app).post('/auth/login').send({ email, password: pwd });
  }

  function verify(mfaPendingToken: unknown, code: string) {
    return request(app).post('/auth/2fa/verify').send({ mfaPendingToken, code });
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

    const [appModule, dbModule, totpModule, passwordModule] = await Promise.all([
      import('../../src/app.js'),
      import('../../src/db/prisma-client.js'),
      import('../../src/modules/auth/services/totp.js'),
      import('../../src/modules/auth/services/password.js'),
    ]);
    app = appModule.createApp();
    prisma = dbModule.prisma;
    totpCodeAtStep = totpModule.totpCodeAtStep;
    timeStepFor = totpModule.timeStepFor;
    hashPassword = passwordModule.hashPassword;

    const signup = await request(app)
      .post('/auth/signup')
      .send({ role: 'doctor', email: doctorEmail, password, fullName: 'Two Factor Doctor' });
    expect(signup.status).toBe(200);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports 2FA as off before enrollment', async () => {
    const loginRes = await login();
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.accessToken as string;

    const status = await request(app).get('/auth/2fa').set('Authorization', `Bearer ${token}`);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ enabled: false, enabledAt: null, pendingEnrollment: false });
  });

  it('starts enrollment with an otpauth URI and stores the secret encrypted at rest', async () => {
    const token = (await login()).body.accessToken as string;
    const setup = await request(app).post('/auth/2fa/setup').set('Authorization', `Bearer ${token}`);

    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri.startsWith('otpauth://totp/')).toBe(true);
    secret = new URL(setup.body.otpauthUri.replace('otpauth://', 'https://')).searchParams.get('secret') as string;
    expect(secret).toHaveLength(32);

    const row = await prisma.twoFactorAuth.findFirstOrThrow({ where: { user: { email: doctorEmail } } });
    // Encrypted at rest: the stored value is not the secret, and it isn't
    // readable without the key.
    expect(row.secretEncrypted).not.toBe(secret);
    expect(row.secretEncrypted).not.toContain(secret);
    expect(row.enabledAt).toBeNull();
  });

  it('does not enforce anything until a first code confirms enrollment', async () => {
    const token = (await login()).body.accessToken as string;

    const wrong = await request(app)
      .post('/auth/2fa/enable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '000000' });
    expect(wrong.status).toBe(401);

    const enabled = await request(app)
      .post('/auth/2fa/enable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: currentCode() });
    expect(enabled.status).toBe(200);
    expect(enabled.body.recoveryCodes).toHaveLength(10);
    recoveryCodes = enabled.body.recoveryCodes as string[];

    // Plaintext recovery codes are returned exactly once — only hashes
    // are persisted.
    const stored = await prisma.twoFactorRecoveryCode.findMany();
    expect(stored).toHaveLength(10);
    for (const code of recoveryCodes) {
      expect(stored.some((row) => row.codeHash === code)).toBe(false);
    }
    expect(stored.every((row) => row.codeHash.startsWith('$2'))).toBe(true);
  });

  it('makes login two-step and returns no session until the code is supplied', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.mfaPendingToken).toBeTruthy();
    expect(res.body.accessToken).toBeUndefined();
    // No refresh cookie either — a half-authenticated login must not be
    // able to start a session.
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects the mfa_pending token on every route except /auth/2fa/verify', async () => {
    const { mfaPendingToken } = (await login()).body as { mfaPendingToken: string };

    const protectedRoute = await request(app).get('/doctors/me').set('Authorization', `Bearer ${mfaPendingToken}`);
    expect(protectedRoute.status).toBe(401);

    const setupRoute = await request(app).post('/auth/2fa/setup').set('Authorization', `Bearer ${mfaPendingToken}`);
    expect(setupRoute.status).toBe(401);

    // Not a refresh token either — different secret.
    const refreshed = await request(app)
      .post('/auth/refresh')
      .set('Cookie', `docforum_refresh=${mfaPendingToken}`);
    expect(refreshed.status).toBe(401);

    // The reverse direction: a genuine access token (here, one obtained by
    // spending a recovery code) is not an mfa_pending token, so the verify
    // endpoint refuses it too. Both directions of the scope check.
    const session = await verify((await login()).body.mfaPendingToken, recoveryCodes[9]);
    expect(session.status).toBe(200);
    const asPending = await verify(session.body.accessToken, currentCode());
    expect(asPending.status).toBe(401);
  });

  it('issues a real session for a valid code', async () => {
    const { mfaPendingToken } = (await login()).body as { mfaPendingToken: string };

    const bad = await verify(mfaPendingToken, '000000');
    expect(bad.status).toBe(401);

    const res = await verify(mfaPendingToken, currentCode());
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.headers['set-cookie']?.[0]).toContain('docforum_refresh');

    const me = await request(app).get('/doctors/me').set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
  });

  it('rejects a replayed code inside its own window', async () => {
    // The next step's code: inside the ±1 window, and guaranteed not to be
    // the step the previous test spent (so the first call is a real
    // success and the second is a genuine replay, not a clock artifact).
    const code = currentCode(1);

    const first = await verify((await login()).body.mfaPendingToken, code);
    expect(first.status).toBe(200);

    const replay = await verify((await login()).body.mfaPendingToken, code);
    expect(replay.status).toBe(401);
  });

  it('accepts each recovery code exactly once', async () => {
    const first = (await login()).body as { mfaPendingToken: string };
    expect((await verify(first.mfaPendingToken, recoveryCodes[0])).status).toBe(200);

    const second = (await login()).body as { mfaPendingToken: string };
    expect((await verify(second.mfaPendingToken, recoveryCodes[0])).status).toBe(401);
    const third = (await login()).body as { mfaPendingToken: string };
    expect((await verify(third.mfaPendingToken, recoveryCodes[1])).status).toBe(200);
  });

  it('requires a current code or a recovery code to disable 2FA', async () => {
    const token = (await login()).body.mfaPendingToken as string;

    const wrong = await request(app)
      .post('/auth/2fa/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '000000' });
    // The mfa_pending token isn't an access token, so this is a 401 at the
    // middleware — and the endpoint can't be reached without a real code.
    expect(wrong.status).toBe(401);

    const session = await verify((await login()).body.mfaPendingToken, recoveryCodes[2]);
    expect(session.status).toBe(200);

    const disabled = await request(app)
      .post('/auth/2fa/disable')
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .send({ code: recoveryCodes[3] });
    expect(disabled.status).toBe(204);

    // Back to single-step login.
    const after = await login();
    expect(after.status).toBe(200);
    expect(after.body.accessToken).toBeTruthy();
    expect(after.body.mfaRequired).toBeUndefined();
  });

  it('blocks an unenrolled admin when REQUIRE_2FA_FOR_ADMIN is on, but only admins', async () => {
    const adminEmail = `admin-${runId}@example.com`;
    await prisma.user.create({
      data: {
        email: adminEmail,
        role: 'admin',
        passwordHash: await hashPassword('admin-password-1'),
      },
    });

    const adminLogin = await login(adminEmail, 'admin-password-1');
    expect(adminLogin.status).toBe(403);
    expect(adminLogin.body.message).toMatch(/two-factor/i);

    // The flag is admin-scoped — a non-admin still logs in single-step.
    const patientEmail = `patient-flag-${runId}@example.com`;
    await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email: patientEmail, password: 'patient-password-1', fullName: 'Flag Patient' });
    expect((await login(patientEmail, 'patient-password-1')).status).toBe(200);
  });
});
