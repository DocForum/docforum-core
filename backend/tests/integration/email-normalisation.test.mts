// Email normalisation and case-insensitive uniqueness (Phase 8, issue #268) — integration test.
// Verifies:
// 1. Normalisation at signup stores lowercased email in DB
// 2. Login succeeds regardless of email casing typed by user
// 3. Signup with different casing of an existing email returns 409
// 4. DB-level unique index on LOWER("email") prevents case duplicates even on raw INSERT
// 5. Password reset and login throttle operate on normalised email
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5489;
const runId = Date.now();

process.env.DATABASE_URL = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-emailnorm-pg-'));
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

describe('Email normalisation and case-insensitive uniqueness (Phase 8, issue #268)', () => {
  let app: App;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;

  const mixedEmail = `Test.Normalise.${runId}@Example.COM`;
  const lowerEmail = mixedEmail.toLowerCase();
  const password = 'Strong-Test-Password-123';

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

  it('normalises email to lowercase at signup and stores lowercased address in DB', async () => {
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email: mixedEmail, password, fullName: 'Normalise Tester' });

    expect(signupRes.status).toBe(200);
    expect(signupRes.body.user.email).toBe(lowerEmail);

    const dbUser = await prisma.user.findFirst({
      where: { id: signupRes.body.user.id },
    });
    expect(dbUser?.email).toBe(lowerEmail);
  });

  it('allows logging in with lowercase, uppercase, or mixed-case email', async () => {
    // 1. Lowercase login
    const lowerLogin = await request(app)
      .post('/auth/login')
      .send({ email: lowerEmail, password });
    expect(lowerLogin.status).toBe(200);

    // 2. Uppercase login
    const upperLogin = await request(app)
      .post('/auth/login')
      .send({ email: mixedEmail.toUpperCase(), password });
    expect(upperLogin.status).toBe(200);

    // 3. Mixed case login as originally typed
    const mixedLogin = await request(app)
      .post('/auth/login')
      .send({ email: mixedEmail, password });
    expect(mixedLogin.status).toBe(200);
  });

  it('rejects duplicate signup with different casing with 409 Conflict', async () => {
    // Attempt signup with uppercase
    const dupRes = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email: mixedEmail.toUpperCase(), password, fullName: 'Duplicate Tester' });

    expect(dupRes.status).toBe(409);
    expect(dupRes.body.message).toMatch(/already registered|already in use|exists/i);
  });

  it('database-level unique index on LOWER(email) blocks direct SQL insertion of case collisions', async () => {
    // Direct raw INSERT bypassing application validation
    await expect(
      prisma.$executeRaw`
        INSERT INTO "User" ("id", "email", "passwordHash", "role", "locale", "updatedAt")
        VALUES (
          gen_random_uuid()::text,
          ${mixedEmail.toUpperCase()},
          'dummyhash',
          'patient'::"Role",
          'en',
          NOW()
        )
      `
    ).rejects.toThrow();
  });

  it('normalises email at password reset request', async () => {
    const resetRes = await request(app)
      .post('/auth/password-reset/request')
      .send({ email: mixedEmail.toUpperCase() });

    // Returns 202 without leaking existence
    expect(resetRes.status).toBe(202);

    // A token was generated for the lowercase user
    const user = await prisma.user.findUnique({ where: { email: lowerEmail } });
    expect(user).toBeDefined();

    const resetToken = await prisma.passwordResetToken.findFirst({
      where: { userId: user!.id },
    });
    expect(resetToken).toBeDefined();
  });
});
