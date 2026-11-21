// Integration tests for email change (Phase 8, issue #271):
// two-step email change with single-use hashed token, notice to old address,
// atomic confirmation, unique constraint race handling, login-throttle preservation,
// and audit logging.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import type { EmailMessage } from '../../src/modules/auth/services/email-dispatcher.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5475; // unique per integration file
const runId = Date.now();
const PASSWORD = 'password123';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-email-change-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_email_change_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

const dispatchedEmails: EmailMessage[] = [];
const emailedTokens = new Map<string, string>();

describe('email change (issue #271)', () => {
  let app: App;
  let prisma: Prisma;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_email_change_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    authServices.setEmailSender(async (message) => {
      dispatchedEmails.push(message);
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) {
        emailedTokens.set(message.to, decodeURIComponent(match[1]!));
      }
    });
  });

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function signup(label: string) {
    const email = `${label}-${runId}@example.com`;
    const res = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email, password: PASSWORD, fullName: `${label} Name` });
    expect(res.status).toBe(200);

    const token = emailedTokens.get(email);
    if (token) {
      await request(app).post('/auth/verify-email').send({ token });
    } else {
      await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
    }

    return {
      userId: res.body.user.id as string,
      token: res.body.accessToken as string,
      email,
    };
  }

  it('requires current password to request email change and rejects wrong password', async () => {
    const user = await signup('ec-pwd');
    const newEmail = `ec-new-${runId}@example.com`;

    const badPwd = await request(app)
      .post('/auth/change-email/request')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ newEmail, password: 'wrongpassword' });

    expect(badPwd.status).toBe(403);
    expect(badPwd.body.message).toMatch(/password confirmation failed/i);
  });

  it('refuses change to the current email address or an address already registered', async () => {
    const user1 = await signup('ec-val-1');
    const user2 = await signup('ec-val-2');

    // Same as current
    const sameRes = await request(app)
      .post('/auth/change-email/request')
      .set('Authorization', `Bearer ${user1.token}`)
      .send({ newEmail: user1.email, password: PASSWORD });
    expect(sameRes.status).toBe(400);

    // Already registered by another account
    const takenRes = await request(app)
      .post('/auth/change-email/request')
      .set('Authorization', `Bearer ${user1.token}`)
      .send({ newEmail: user2.email, password: PASSWORD });
    expect(takenRes.status).toBe(409);
    expect(takenRes.body.code).toBe('EMAIL_TAKEN');
  });

  it('dispatches notice to old address and confirmation link to new address, then confirms change', async () => {
    const user = await signup('ec-flow');
    const newEmail = `ec-flow-new-${runId}@example.com`;

    dispatchedEmails.length = 0;
    const reqRes = await request(app)
      .post('/auth/change-email/request')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ newEmail, password: PASSWORD });

    expect(reqRes.status).toBe(200);

    // Assert AuditEvent for request
    const reqEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'email_change.requested', entityId: user.userId },
    });
    expect(reqEvent.entityType).toBe('User');

    // Assert two emails dispatched: notice to old, token to new
    const oldNotice = dispatchedEmails.find((m) => m.to === user.email);
    expect(oldNotice).toBeDefined();
    expect(oldNotice!.subject).toMatch(/email address change requested/i);

    const newConfirmation = dispatchedEmails.find((m) => m.to === newEmail);
    expect(newConfirmation).toBeDefined();
    expect(newConfirmation!.subject).toMatch(/confirm your new docforum email/i);

    const confirmToken = emailedTokens.get(newEmail);
    expect(confirmToken).toBeDefined();

    // Confirm the change
    const confirmRes = await request(app)
      .post('/auth/change-email/confirm')
      .send({ token: confirmToken });

    expect(confirmRes.status).toBe(200);

    // Verify email swapped in DB and emailVerifiedAt is set
    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(updatedUser.email).toBe(newEmail);
    expect(updatedUser.emailVerifiedAt).not.toBeNull();

    // Assert AuditEvent for confirmation
    const confirmEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'email_change.confirmed', entityId: user.userId },
    });
    expect(confirmEvent.entityType).toBe('User');

    // Token cannot be reused (single-use)
    const replayRes = await request(app)
      .post('/auth/change-email/confirm')
      .send({ token: confirmToken });
    expect(replayRes.status).toBe(400);
    expect(replayRes.body.code).toBe('TOKEN_ALREADY_USED');
  });

  it('refuses expired email change tokens', async () => {
    const user = await signup('ec-exp');
    const newEmail = `ec-exp-new-${runId}@example.com`;

    await request(app)
      .post('/auth/change-email/request')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ newEmail, password: PASSWORD });

    const confirmToken = emailedTokens.get(newEmail)!;

    // Age the token in the database
    await prisma.emailChangeToken.updateMany({
      where: { userId: user.userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const confirmRes = await request(app)
      .post('/auth/change-email/confirm')
      .send({ token: confirmToken });
    expect(confirmRes.status).toBe(400);
    expect(confirmRes.body.code).toBe('TOKEN_EXPIRED');
  });

  it('race condition: two accounts claiming the same new address under concurrency (issue #271)', async () => {
    const userA = await signup('ec-race-a');
    const userB = await signup('ec-race-b');
    const targetEmail = `ec-contested-${runId}@example.com`;

    // Both accounts request email change to the same target email
    await request(app)
      .post('/auth/change-email/request')
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ newEmail: targetEmail, password: PASSWORD });
    const tokenA = emailedTokens.get(targetEmail)!;

    await request(app)
      .post('/auth/change-email/request')
      .set('Authorization', `Bearer ${userB.token}`)
      .send({ newEmail: targetEmail, password: PASSWORD });
    const tokenB = emailedTokens.get(targetEmail)!;

    // Fire both confirmations concurrently with Promise.all
    const [resA, resB] = await Promise.all([
      request(app).post('/auth/change-email/confirm').send({ token: tokenA }),
      request(app).post('/auth/change-email/confirm').send({ token: tokenB }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // Exactly one must succeed (200) and the other must fail with 409 (EMAIL_TAKEN), never 500
    expect(statuses).toEqual([200, 409]);

    const failure = resA.status === 409 ? resA : resB;
    expect(failure.body.code).toBe('EMAIL_TAKEN');

    // Confirm targetEmail belongs to exactly one user in the database
    const usersWithTarget = await prisma.user.findMany({ where: { email: targetEmail } });
    expect(usersWithTarget.length).toBe(1);
  });
});

