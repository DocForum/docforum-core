// Auth-artifact retention (Phase 8, issue #276) — integration against a real
// Postgres.
//
// Proves the prune is bounded, deletes only rows past expiry/consumption by
// the grace period, and never touches a live token, a live invite or an
// active refresh session.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';

// Read by src/config/sections/tokenPrune.ts at import time — small values
// make both the grace period and the batching observable.
process.env.AUTH_TOKEN_PRUNE_GRACE_HOURS = '1';
process.env.AUTH_TOKEN_PRUNE_BATCH_SIZE = '2';
process.env.AUTH_TOKEN_PRUNE_MAX_BATCHES_PER_RUN = '10';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5476;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-auth-prune-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

describe('auth token prune', () => {
  let prisma: Prisma;
  let userModule: typeof import('../../src/modules/auth/services/index.js');
  let usersModule: typeof import('../../src/modules/users/services/index.js');
  let paymentsModule: typeof import('../../src/modules/payments/services/index.js');
  let jobModule: typeof import('../../src/jobs/auth-token-prune.js');
  let userId: string;

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

    const [dbModule, authModule, usersServices, paymentsServices, job] = await Promise.all([
      import('../../src/db/prisma-client.js'),
      import('../../src/modules/auth/services/index.js'),
      import('../../src/modules/users/services/index.js'),
      import('../../src/modules/payments/services/index.js'),
      import('../../src/jobs/auth-token-prune.js'),
    ]);
    prisma = dbModule.prisma;
    userModule = authModule;
    usersModule = usersServices;
    paymentsModule = paymentsServices;
    jobModule = job;

    const user = await prisma.user.create({
      data: {
        email: `prune-owner-${runId}@example.com`,
        passwordHash: 'not-a-real-hash',
        role: 'patient',
        emailVerifiedAt: new Date(),
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('removes only expired/consumed/revoked rows and leaves live rows intact', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 60 * 60 * 1000); // past 1h grace
    const recent = new Date(now.getTime() - 5 * 60 * 1000); // inside grace
    const future = new Date(now.getTime() + 60 * 60 * 1000);

    // --- Email verification tokens -------------------------------------
    const expiredVerification = await prisma.emailVerificationToken.create({
      data: { userId, tokenHash: `old-expired-${runId}`, expiresAt: old },
    });
    const consumedVerification = await prisma.emailVerificationToken.create({
      data: { userId, tokenHash: `old-consumed-${runId}`, expiresAt: future, consumedAt: old },
    });
    const recentVerification = await prisma.emailVerificationToken.create({
      data: { userId, tokenHash: `recent-consumed-${runId}`, expiresAt: future, consumedAt: recent },
    });
    const liveVerification = await prisma.emailVerificationToken.create({
      data: { userId, tokenHash: `live-${runId}`, expiresAt: future },
    });

    // --- Password reset tokens -----------------------------------------
    await prisma.passwordResetToken.create({
      data: { userId, tokenHash: `old-reset-expired-${runId}`, expiresAt: old },
    });
    await prisma.passwordResetToken.create({
      data: { userId, tokenHash: `old-reset-used-${runId}`, expiresAt: future, usedAt: old },
    });
    const recentReset = await prisma.passwordResetToken.create({
      data: { userId, tokenHash: `recent-reset-used-${runId}`, expiresAt: future, usedAt: recent },
    });
    const liveReset = await prisma.passwordResetToken.create({
      data: { userId, tokenHash: `live-reset-${runId}`, expiresAt: future },
    });

    // --- Admin invites --------------------------------------------------
    await prisma.adminInvite.create({
      data: { email: `old-expired-${runId}@example.com`, tokenHash: `invite-old-expired-${runId}`, expiresAt: old, invitedByUserId: userId },
    });
    await prisma.adminInvite.create({
      data: {
        email: `old-consumed-${runId}@example.com`,
        tokenHash: `invite-old-consumed-${runId}`,
        expiresAt: future,
        consumedAt: old,
        invitedByUserId: userId,
      },
    });
    const liveInvite = await prisma.adminInvite.create({
      data: { email: `live-${runId}@example.com`, tokenHash: `invite-live-${runId}`, expiresAt: future, invitedByUserId: userId },
    });

    // --- Refresh sessions ----------------------------------------------
    const oldRevokedSession = await prisma.refreshSession.create({
      data: { userId, revokedAt: old, revokedReason: 'max_active_sessions' },
    });
    const activeSession = await prisma.refreshSession.create({ data: { userId } });
    const recentRevokedSession = await prisma.refreshSession.create({
      data: { userId, revokedAt: recent },
    });

    // --- SEP-10 challenges ---------------------------------------------
    await prisma.sep10Challenge.create({
      data: { userId, account: 'GOLDEXPIRED', nonce: `sep10-old-expired-${runId}`, expiresAt: old },
    });
    await prisma.sep10Challenge.create({
      data: { userId, account: 'GOLDUSED', nonce: `sep10-old-used-${runId}`, expiresAt: future, consumedAt: old },
    });
    const liveChallenge = await prisma.sep10Challenge.create({
      data: { userId, account: 'GLIVE', nonce: `sep10-live-${runId}`, expiresAt: future },
    });

    const counts = await jobModule.runAuthTokenPrune(now);

    expect(counts['email-verification tokens']).toBe(2);
    expect(counts['password-reset tokens']).toBe(2);
    expect(counts['admin invites']).toBe(2);
    expect(counts['revoked refresh sessions']).toBe(1);
    expect(counts['SEP-10 challenges']).toBe(2);

    // Every live row survives.
    expect(await prisma.emailVerificationToken.findMany({ where: { id: { in: [liveVerification.id, recentVerification.id] } } })).toHaveLength(2);
    expect(await prisma.emailVerificationToken.findMany({ where: { id: { in: [expiredVerification.id, consumedVerification.id] } } })).toHaveLength(0);
    expect(await prisma.passwordResetToken.findMany({ where: { id: { in: [liveReset.id, recentReset.id] } } })).toHaveLength(2);
    expect(await prisma.adminInvite.findMany({ where: { id: liveInvite.id } })).toHaveLength(1);
    expect(await prisma.refreshSession.findMany({ where: { id: { in: [activeSession.id, recentRevokedSession.id] } } })).toHaveLength(2);
    expect(await prisma.refreshSession.findMany({ where: { id: oldRevokedSession.id } })).toHaveLength(0);
    expect(await prisma.sep10Challenge.findMany({ where: { id: liveChallenge.id } })).toHaveLength(1);
  });

  it('deletes in bounded batches rather than one unbounded statement', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    for (let index = 0; index < 5; index += 1) {
      await prisma.emailVerificationToken.create({
        data: { userId, tokenHash: `batch-${index}-${runId}`, expiresAt: old },
      });
    }

    // A single call removes exactly one batch (config batchSize = 2).
    expect(await userModule.pruneExpiredVerificationTokens({ now })).toBe(2);
    expect(await prisma.emailVerificationToken.count({ where: { tokenHash: { startsWith: `batch-` } } })).toBe(3);
    expect(await userModule.pruneExpiredVerificationTokens({ now })).toBe(2);
    expect(await prisma.emailVerificationToken.count({ where: { tokenHash: { startsWith: `batch-` } } })).toBe(1);
    expect(await userModule.pruneExpiredVerificationTokens({ now })).toBe(1);
    expect(await prisma.emailVerificationToken.count({ where: { tokenHash: { startsWith: `batch-` } } })).toBe(0);
  });

  it('exposes each table prune through its module service surface', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    await prisma.adminInvite.create({
      data: { email: `service-${runId}@example.com`, tokenHash: `invite-service-${runId}`, expiresAt: old, invitedByUserId: userId },
    });
    expect(await usersModule.pruneExpiredAdminInvites({ now })).toBe(1);

    await prisma.sep10Challenge.create({
      data: { userId, account: 'GSERVICE', nonce: `sep10-service-${runId}`, expiresAt: old },
    });
    expect(await paymentsModule.pruneExpiredSep10Challenges({ now })).toBe(1);

    const revoked = await prisma.refreshSession.create({ data: { userId, revokedAt: old } });
    expect(await userModule.pruneRevokedRefreshSessions({ now })).toBe(1);
    expect(await prisma.refreshSession.findMany({ where: { id: revoked.id } })).toHaveLength(0);
  });
});
