// Integration tests for issue #36: TOTP two-factor authentication.
//
// What this file proves, over HTTP against a real Postgres:
//   1. enrolment returns an otpauth URI + ten single-use recovery codes;
//   2. login becomes two-step — password returns only an `mfa_pending` token,
//      and that token is rejected by a normal protected route;
//   3. a replayed TOTP code is refused (the step is claimed once);
//   4. a recovery code works exactly once;
//   5. disabling requires a current/recovery code and restores one-step login;
//   6. with TOTP_REQUIRE_FOR_ADMIN=true, an unenrolled admin gets only the
//      narrow `mfa_enrollment` token, which can reach setup/enable and
//      nothing else.
//
// Self-contained like the other integration suites: its own embedded
// Postgres on its own port (5471) with the committed migrations applied.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { generateTotp } from '../../src/modules/auth/services/totp.js';

// Read by src/config at import time (in beforeAll, after this line).
process.env.TOTP_REQUIRE_FOR_ADMIN = 'true';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5471;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-two-factor-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
process.env.DATABASE_URL = databaseUrl;

const emailedTokens = new Map<string, string>();

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

const PASSWORD = 'longenough123';

/**
 * Clears the replay guard, standing in for "wait until the next time step".
 * Real time can't be advanced in-process, and a future-offset code would fall
 * outside the ±1-step skew window — so each independent login test starts
 * from "no step used yet" and submits the *current* code. The replay test is
 * the one case that keeps the guard between its two submissions.
 */
async function resetReplayGuard(prisma: Prisma, email: string) {
  await prisma.user.update({ where: { email }, data: { totpLastUsedStep: null } });
}

describe('issue #36: TOTP two-factor authentication', () => {
  let app: App;
  let prisma: Prisma;

  let patientToken: string;
  let patientEmail: string;
  let secret: string;
  let recoveryCodes: string[] = [];

  let adminEmail: string;

  async function login(email: string) {
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

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;
    authServices.setEmailSender(async (message) => {
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
    });

    patientEmail = `twofa-patient-${runId}@example.com`;
    const signup = await request(app).post('/auth/signup').send({ role: 'patient', email: patientEmail, password: PASSWORD, fullName: 'Two Factor Patient' });
    expect(signup.status, JSON.stringify(signup.body)).toBe(200);
    const verificationToken = emailedTokens.get(patientEmail);
    expect(verificationToken).toBeTruthy();
    const verified = await request(app).post('/auth/verify-email').send({ token: verificationToken });
    expect(verified.status).toBe(200);
    patientToken = signup.body.accessToken;

    // Admins are invite/seed only (PRD OQ-2) — create the account directly in
    // the DB, exactly like the admin-bootstrap path does.
    const bcryptjs = await import('bcryptjs');
    adminEmail = `twofa-admin-${runId}@example.com`;
    await prisma.user.create({
      data: { email: adminEmail, passwordHash: await bcryptjs.hash(PASSWORD, 4), role: 'admin', emailVerifiedAt: new Date() },
    });
  });

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('enrols a user and returns ten single-use recovery codes', async () => {
    const setup = await request(app).post('/auth/2fa/setup').set('Authorization', `Bearer ${patientToken}`);
    expect(setup.status, JSON.stringify(setup.body)).toBe(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    secret = setup.body.secret;
    expect(secret).toMatch(/^[A-Z2-7]+$/);

    const enable = await request(app)
      .post('/auth/2fa/enable')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ code: generateTotp(secret) });
    expect(enable.status, JSON.stringify(enable.body)).toBe(200);
    recoveryCodes = enable.body.recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);

    // Only hashes are stored — no plaintext code reaches the database.
    const stored = await prisma.twoFactorRecoveryCode.findMany({ where: { user: { email: patientEmail } } });
    expect(stored).toHaveLength(10);
    for (const row of stored) expect(row.codeHash).toMatch(/^[a-f0-9]{64}$/);

    const status = await request(app).get('/auth/2fa/status').set('Authorization', `Bearer ${patientToken}`);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ enabled: true, unusedRecoveryCodes: 10 });
  });

  it('makes login two-step, and the mfa_pending token reaches nothing but /2fa/verify', async () => {
    const first = await login(patientEmail);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ mfaRequired: true });
    expect(first.body.accessToken).toBeUndefined();
    expect(first.headers['set-cookie']).toBeUndefined();

    // The half-authenticated token is not an access token.
    const guarded = await request(app).get('/auth/sessions').set('Authorization', `Bearer ${first.body.mfaToken}`);
    expect(guarded.status).toBe(401);

    // And it can't be used on the enrolment endpoints either.
    const wrongEndpoint = await request(app).post('/auth/2fa/setup').set('Authorization', `Bearer ${first.body.mfaToken}`);
    expect(wrongEndpoint.status).toBe(401);

    const wrongCode = await request(app).post('/auth/2fa/verify').send({ mfaToken: first.body.mfaToken, code: '000000' });
    expect(wrongCode.status).toBe(401);

    // Enrolment consumed the first code; treat this as a later step.
    await resetReplayGuard(prisma, patientEmail);
    const verified = await request(app)
      .post('/auth/2fa/verify')
      .send({ mfaToken: first.body.mfaToken, code: generateTotp(secret) });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    expect(verified.body.user.email).toBe(patientEmail);
    expect(verified.body.accessToken).toBeTruthy();
    expect(verified.headers['set-cookie']).toBeDefined();

    const sessions = await request(app).get('/auth/sessions').set('Authorization', `Bearer ${verified.body.accessToken}`);
    expect(sessions.status).toBe(200);
  });

  it('rejects a replayed TOTP code', async () => {
    await resetReplayGuard(prisma, patientEmail);
    const code = generateTotp(secret);

    const first = await login(patientEmail);
    const verified = await request(app).post('/auth/2fa/verify').send({ mfaToken: first.body.mfaToken, code });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);

    // Same code, same step, second session attempt: the conditional step
    // claim is what refuses it.
    const second = await login(patientEmail);
    const replay = await request(app).post('/auth/2fa/verify').send({ mfaToken: second.body.mfaToken, code });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('TOTP_CODE_REPLAYED');
  });

  it('accepts a recovery code exactly once', async () => {
    const first = await login(patientEmail);
    const ok = await request(app).post('/auth/2fa/verify').send({ mfaToken: first.body.mfaToken, code: recoveryCodes[0] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const second = await login(patientEmail);
    const reuse = await request(app).post('/auth/2fa/verify').send({ mfaToken: second.body.mfaToken, code: recoveryCodes[0] });
    expect(reuse.status).toBe(401);
  });

  it('requires a code to disable, then returns to one-step login', async () => {
    const bad = await request(app)
      .post('/auth/2fa/disable')
      .set('Authorization', `Bearer ${(await login(patientEmail)).body.mfaToken}`)
      .send({ code: '000000' });
    // An mfa_pending token cannot disable anything (401 from authenticate).
    expect(bad.status).toBe(401);

    await resetReplayGuard(prisma, patientEmail);
    const session = await request(app)
      .post('/auth/2fa/verify')
      .send({ mfaToken: (await login(patientEmail)).body.mfaToken, code: generateTotp(secret) });
    expect(session.status, JSON.stringify(session.body)).toBe(200);

    const wrong = await request(app)
      .post('/auth/2fa/disable')
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .send({ code: '111111' });
    expect(wrong.status).toBe(401);

    const disabled = await request(app)
      .post('/auth/2fa/disable')
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .send({ code: recoveryCodes[1] });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(204);

    const plain = await login(patientEmail);
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(plain.body.accessToken).toBeTruthy();
    expect(plain.body.mfaRequired).toBeUndefined();

    const status = await request(app).get('/auth/2fa/status').set('Authorization', `Bearer ${plain.body.accessToken}`);
    expect(status.body).toEqual({ enabled: false, unusedRecoveryCodes: 0 });
  });

  it('gives an admin who must enrol only the narrow mfa_enrollment token', async () => {
    const first = await login(adminEmail);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ enrollmentRequired: true });
    expect(first.body.accessToken).toBeUndefined();

    // The enrolment token is not a session.
    const guarded = await request(app).get('/auth/sessions').set('Authorization', `Bearer ${first.body.enrollmentToken}`);
    expect(guarded.status).toBe(401);

    const setup = await request(app).post('/auth/2fa/setup').set('Authorization', `Bearer ${first.body.enrollmentToken}`);
    expect(setup.status, JSON.stringify(setup.body)).toBe(200);

    const enable = await request(app)
      .post('/auth/2fa/enable')
      .set('Authorization', `Bearer ${first.body.enrollmentToken}`)
      .send({ code: generateTotp(setup.body.secret) });
    expect(enable.status, JSON.stringify(enable.body)).toBe(200);
    expect(enable.body.recoveryCodes).toHaveLength(10);

    // Now the admin is enrolled: login is two-step like everyone else's.
    const second = await login(adminEmail);
    expect(second.body).toMatchObject({ mfaRequired: true });

    await resetReplayGuard(prisma, adminEmail);
    const verified = await request(app)
      .post('/auth/2fa/verify')
      .send({ mfaToken: second.body.mfaToken, code: generateTotp(setup.body.secret) });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    expect(verified.body.user.role).toBe('admin');
  });
});
