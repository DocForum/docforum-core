// Referral accept contention (issue #349): many patients accept referrals
// into one specialist's few slots at the same moment. The same seeding and
// database invariants as the k6 scenario in tests/load/, run in-process so
// CI checks them on every PR. Port 5490.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import { acceptReferral, installEmailCapture, resetEmailSenderFixture } from './helpers/fixtures.mjs';
import {
  seedReferralAcceptContention,
  verifyReferralAcceptContention,
  type ContentionSeed,
} from '../load/referral-accept-contention-lib.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5490;
const REFERRALS = 12;
const SLOTS = 3;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-test-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

describe('referral accept contention (issue #349)', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let seed: ContentionSeed;

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
    app = (await import('../../src/app.js')).createApp();
    prisma = (await import('../../src/db/prisma-client.js')).prisma;

    const emailedTokens = new Map<string, string>();
    await installEmailCapture(emailedTokens);
    seed = await seedReferralAcceptContention(app, prisma, emailedTokens, {
      referralCount: REFERRALS,
      slotCount: SLOTS,
      runId: Date.now(),
    });
  });

  afterAll(async () => {
    await resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('seeds pending referrals that all pass the invariants before the run', async () => {
    expect(seed.referrals).toHaveLength(REFERRALS);
    expect(await prisma.availabilitySlot.count({ where: { doctorProfileId: seed.targetDoctorId } })).toBe(SLOTS);
    const before = await verifyReferralAcceptContention(prisma, seed);
    expect(before).toEqual({ violations: [], accepted: 0, pending: REFERRALS });
  });

  it('books each contended slot once and leaves every losing referral pending', async () => {
    const responses = await Promise.all(
      seed.referrals.map((r) => acceptReferral(app, { accessToken: r.patientToken }, r.id, r.targetSlotId)),
    );
    // Only 200 (won) and 409 (slot taken) are acceptable outcomes; the
    // correctness verdict itself comes from the database below.
    for (const res of responses) expect([200, 409]).toContain(res.status);

    const result = await verifyReferralAcceptContention(prisma, seed);
    expect(result.violations).toEqual([]);
    // Every slot had contenders, so each ends with exactly one winner.
    expect(result.accepted).toBe(SLOTS);
    expect(result.pending).toBe(REFERRALS - SLOTS);
  });

  it('flags a double-booked slot and an inconsistent referral', async () => {
    const winner = await prisma.referral.findFirstOrThrow({
      where: { id: { in: seed.referrals.map((r) => r.id) }, status: 'accepted' },
    });
    const loser = await prisma.referral.findFirstOrThrow({
      where: { id: { in: seed.referrals.map((r) => r.id) }, status: 'pending' },
    });
    // Corrupt the outcome the way a broken accept path would: a pending
    // referral claiming an appointment, and an accepted one losing it.
    await prisma.referral.update({ where: { id: winner.id }, data: { resultingAppointmentId: null } });
    await prisma.referral.update({ where: { id: loser.id }, data: { resultingAppointmentId: winner.resultingAppointmentId } });

    const result = await verifyReferralAcceptContention(prisma, seed);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        `referral ${winner.id} does not point at its appointment`,
        `pending referral ${loser.id} has a resulting appointment`,
      ]),
    );
  });
});
