// Referral expiry job (issue #8): a pending referral older than the TTL is
// expired (reason `ttl`, distinct from declined), fresh/accepted/declined ones
// are left alone, and the sweep is idempotent. Port 5455.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import {
  acceptReferral,
  consultationRitual,
  createReferral,
  generateSlots,
  installEmailCapture,
  makeDoctor,
  makePatient,
  makeSpecialty,
  resetEmailSenderFixture,
} from './helpers/fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5455;
const runId = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-test-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

describe('referral expiry job', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let expireStaleReferrals: typeof import('../../src/modules/referrals/services/index.js').expireStaleReferrals;
  let ttlDays: number;
  const emailedTokens = new Map<string, string>();
  let doctorA: Awaited<ReturnType<typeof makeDoctor>>;
  let doctorB: Awaited<ReturnType<typeof makeDoctor>>;
  let patient: Awaited<ReturnType<typeof makePatient>>;

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
    const configModule = await import('../../src/config/index.js');
    const referralsService = await import('../../src/modules/referrals/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;
    expireStaleReferrals = referralsService.expireStaleReferrals;
    ttlDays = configModule.config.referrals.pendingTtlDays;

    await installEmailCapture(emailedTokens);
    const specialtyId = await makeSpecialty(prisma, `Cardiology ${runId}`);
    doctorA = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId });
    doctorB = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId });
    patient = await makePatient(app, emailedTokens, runId);
  });

  afterAll(async () => {
    await resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function newReferral() {
    const { consultationId } = await consultationRitual(app, patient as never, doctorA as never);
    const created = await createReferral(app, doctorA, {
      sourceConsultationId: consultationId,
      targetDoctorId: doctorB.profileId,
      snapshotNotes: 'expiry fixture',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.id as string;
  }

  /** Make a referral look `days` old without waiting. */
  async function age(referralId: string, days: number) {
    await prisma.referral.update({
      where: { id: referralId },
      data: { updatedAt: new Date(Date.now() - days * DAY_MS) },
    });
  }

  it('expires a pending referral older than the TTL, as `expired`/`ttl` (not declined)', async () => {
    const id = await newReferral();
    await age(id, ttlDays + 1);

    const { expired } = await expireStaleReferrals();
    expect(expired).toBeGreaterThanOrEqual(1);

    const row = await prisma.referral.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('expired');
    expect(row.status).not.toBe('declined');
    expect(row.expiredReason).toBe('ttl');
    expect(row.expiredAt).not.toBeNull();
    expect(row.referringDoctorNotifiedAt).not.toBeNull();
    expect(row.snapshotNotes).toBe('expiry fixture'); // snapshot untouched
  });

  it('leaves a recent pending referral alone', async () => {
    const id = await newReferral();
    await age(id, ttlDays - 1);

    await expireStaleReferrals();

    const row = await prisma.referral.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('pending');
    expect(row.expiredAt).toBeNull();
    expect(row.expiredReason).toBeNull();
  });

  it('never touches accepted or declined referrals, however old', async () => {
    const acceptedId = await newReferral();
    const slots = await generateSlots(app, doctorB, 1);
    const accepted = await acceptReferral(app, patient, acceptedId, slots[0]);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    const declinedId = await newReferral();
    const declined = await request(app)
      .post(`/referrals/${declinedId}/decline`)
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(declined.status).toBe(200);

    await age(acceptedId, ttlDays + 30);
    await age(declinedId, ttlDays + 30);

    await expireStaleReferrals();

    expect((await prisma.referral.findUniqueOrThrow({ where: { id: acceptedId } })).status).toBe('accepted');
    const stillDeclined = await prisma.referral.findUniqueOrThrow({ where: { id: declinedId } });
    expect(stillDeclined.status).toBe('declined');
    expect(stillDeclined.expiredReason).toBeNull();
  });

  it('is idempotent: a second sweep expires nothing more', async () => {
    const id = await newReferral();
    await age(id, ttlDays + 1);

    const first = await expireStaleReferrals();
    expect(first.expired).toBeGreaterThanOrEqual(1);
    const second = await expireStaleReferrals();
    expect(second.expired).toBe(0);
    expect((await prisma.referral.findUniqueOrThrow({ where: { id } })).status).toBe('expired');
  });

  it('an expired referral can no longer be accepted', async () => {
    const id = await newReferral();
    await age(id, ttlDays + 1);
    await expireStaleReferrals();

    const slots = await generateSlots(app, doctorB, 1);
    const res = await acceptReferral(app, patient, id, slots[0]);
    expect(res.status).toBe(409);
  });
});
