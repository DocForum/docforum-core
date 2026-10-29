// Integration tests for optimistic concurrency on mutable records
// (Phase 8, issue #49; convention documented in ARCHITECTURE.md §5.4).
//
// This is the lost-update proof: two actors read the same record, both
// decide to write, and the API must let exactly one of them through and
// answer the other with 412 instead of silently discarding their change.
// Self-contained, same embedded-Postgres pattern as booking.test.mts, on its
// own port (5443). The escrow SDK is faked — on-chain behaviour is the
// testnet suite's job.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import EmbeddedPostgres from 'embedded-postgres';
import { createOrderFixture, createPaymentIntentForFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5443;
const runId = Date.now();
const TX_HASH = 'd'.repeat(64);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-concurrency-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_concurrency_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

const emailedTokens = new Map<string, string>();

describe('optimistic concurrency (version + If-Match)', () => {
  let app: App;
  let prisma: Prisma;
  let admin: { id: string; token: string };
  let doctor: { userId: string; profileId: string; token: string };
  /** A second doctor, so the admin verification test can't move the version
   * the PATCH /doctors/me assertions are built on. */
  let otherDoctor: { userId: string; profileId: string; token: string };
  let patient: { userId: string; profileId: string; token: string };
  let facilityId: string;
  let slotId: string;

  const adminAuth = () => ({ Authorization: `Bearer ${admin.token}` });
  const asUser = (d: { token: string }) => ({ Authorization: `Bearer ${d.token}` });

  async function signup(role: 'patient' | 'doctor', label: string) {
    const email = `${label}-${runId}@example.com`;
    const res = await request(app)
      .post('/auth/signup')
      .send({ role, email, password: 'longenough123', fullName: `${label} Fullname` });
    expect(res.status).toBe(200);
    expect((await request(app).post('/auth/verify-email').send({ token: emailedTokens.get(email) })).status).toBe(200);
    return { userId: res.body.user.id as string, token: res.body.accessToken as string, email };
  }

  async function createIntent() {
    const order = await createOrderFixture(prisma, {
      patientProfileId: patient.profileId,
      facilityProfileId: facilityId,
      kind: 'lab_order',
      amountStroops: 5000n,
      tag: `occ-${Math.random().toString(36).slice(2)}`,
    });
    return createPaymentIntentForFixture(prisma, order, 'created');
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_concurrency_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;
    process.env.PLATFORM_PAYER_SECRET = `CCONCPPAYERSENTINEL${runId}`;
    process.env.PLATFORM_RELEASER_SECRET = `CCONCPRELEASERSENTINEL${runId}`;
    process.env.ESCROW_CONTRACT_ID = 'CTESTCONTRACT';
    process.env.ESCROW_TOKEN_ID = 'CTESTTOKEN';

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    const paymentsServices = await import('../../src/modules/payments/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    authServices.setEmailSender(async (message) => {
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
    });

    class FakeEscrowClient {
      async createEscrow() {
        return { escrowId: 501n, txHash: TX_HASH };
      }
      async release() {}
      async refund() {}
    }
    paymentsServices.setEscrowSdkForTests({
      Keypair: { fromSecret: () => ({ publicKey: () => 'GPLATFORMRELEASERPUBLICKEY' }) },
      EscrowClient: FakeEscrowClient,
    } as unknown as import('../../src/modules/payments/services/index.js').EscrowSdkModule);

    const adminUser = await prisma.user.create({
      data: { email: `admin-${runId}@example.com`, passwordHash: 'x', role: 'admin', emailVerifiedAt: new Date() },
    });
    admin = {
      id: adminUser.id,
      token: jwt.sign({ sub: adminUser.id, role: 'admin' }, 'test-access-secret', { expiresIn: '15m' }),
    };

    const doctorUser = await signup('doctor', 'cc-doctor');
    doctor = { ...doctorUser, profileId: (await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doctorUser.userId } })).id };
    const otherDoctorUser = await signup('doctor', 'cc-doctor-other');
    otherDoctor = {
      ...otherDoctorUser,
      profileId: (await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: otherDoctorUser.userId } })).id,
    };
    const patientUser = await signup('patient', 'cc-patient');
    patient = {
      ...patientUser,
      profileId: (await prisma.patientProfile.findUniqueOrThrow({ where: { userId: patientUser.userId } })).id,
    };

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set(asUser(doctor))
      .send({ date: tomorrow, startHour: 9, endHour: 12, slotLengthMinutes: 30 });
    slotId = ((await request(app).get(`/availability/doctors/${doctor.profileId}/slots`)).body as { id: string }[])[0]!.id;

    const facilityUser = await prisma.user.create({ data: { email: `lab-${runId}@example.com`, passwordHash: 'x', role: 'facility' } });
    facilityId = (await prisma.facilityProfile.create({ data: { userId: facilityUser.id, name: 'Concurrency Lab', type: 'lab' } })).id;
    await prisma.walletLink.create({ data: { ownerType: 'facility', ownerId: facilityId, stellarPublicKey: `G${'B'.repeat(55)}`, verificationMethod: 'sep10', activeOwnerKey: `facility:${facilityId}` } });
  }, 180_000);

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    const paymentsServices = await import('../../src/modules/payments/services/index.js');
    authServices.resetEmailSender();
    paymentsServices.setEscrowSdkForTests(undefined);
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('doctor profile — PATCH /doctors/me', () => {
    it('publishes a strong version ETag on the individual resource read', async () => {
      const res = await request(app).get('/doctors/me').set(asUser(doctor));
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);
      expect(res.headers.etag).toBe('"1"');
    });

    it('refuses a write with no If-Match and says how to recover (428)', async () => {
      const res = await request(app).patch('/doctors/me').set(asUser(doctor)).send({ fullName: 'No Precondition' });
      expect(res.status).toBe(428);
      expect(res.body.code).toBe('IF_MATCH_REQUIRED');
      expect(res.body.message).toMatch(/If-Match/);
      // Nothing changed: a refused precondition is not a partial write.
      expect((await prisma.doctorProfile.findUniqueOrThrow({ where: { id: doctor.profileId } })).fullName).not.toBe(
        'No Precondition',
      );
    });

    it('rejects a weak validator, a list and garbage with 400 rather than guessing', async () => {
      for (const value of ['W/"2"', '"2", "3"', '2', 'abc', '"-1"', '"0"']) {
        const res = await request(app).patch('/doctors/me').set(asUser(doctor)).set('If-Match', value).send({ fullName: 'Bad Tag' });
        expect(res.status, `If-Match: ${value}`).toBe(400);
        expect(res.body.code).toBe('INVALID_IF_MATCH');
      }
      expect((await prisma.doctorProfile.findUniqueOrThrow({ where: { id: doctor.profileId } })).version).toBe(1);
    });

    it('applies the write and increments the version in the same response', async () => {
      const current = await request(app).get('/doctors/me').set(asUser(doctor));
      const res = await request(app)
        .patch('/doctors/me')
        .set(asUser(doctor))
        .set('If-Match', current.headers.etag)
        .send({ fullName: 'Renamed Doctor' });
      expect(res.status).toBe(200);
      expect(res.body.fullName).toBe('Renamed Doctor');
      expect(res.body.version).toBe(current.body.version + 1);
      expect(res.headers.etag).toBe(`"${res.body.version}"`);
      // The database agrees — the increment happened in the guarded UPDATE.
      expect((await prisma.doctorProfile.findUniqueOrThrow({ where: { id: doctor.profileId } })).version).toBe(
        res.body.version,
      );
    });

    it('rejects a stale write with 412 and leaves the winning value in place', async () => {
      const stale = (await request(app).get('/doctors/me').set(asUser(doctor))).headers.etag;
      const first = await request(app).patch('/doctors/me').set(asUser(doctor)).set('If-Match', stale).send({ fullName: 'First Writer' });
      expect(first.status).toBe(200);

      const loser = await request(app)
        .patch('/doctors/me')
        .set(asUser(doctor))
        .set('If-Match', stale)
        .send({ fullName: 'Second Writer' });
      expect(loser.status).toBe(412);
      expect(loser.body.code).toBe('VERSION_CONFLICT');

      // The classic lost-update check: the first writer's value survived, and
      // the version moved exactly once — not twice.
      const stored = await prisma.doctorProfile.findUniqueOrThrow({ where: { id: doctor.profileId } });
      expect(stored.fullName).toBe('First Writer');
      expect(stored.version).toBe(first.body.version);

      // And re-reading then retrying the loser's intent succeeds.
      const retry = await request(app).patch('/doctors/me').set(asUser(doctor)).set('If-Match', `"${stored.version}"`).send({
        fullName: 'Second Writer',
      });
      expect(retry.status).toBe(200);
      expect(retry.body.fullName).toBe('Second Writer');
    });

    it('lets exactly one of 8 simultaneous writes on the same version through', async () => {
      const etag = (await request(app).get('/doctors/me').set(asUser(doctor))).headers.etag;
      const versionBefore = (await prisma.doctorProfile.findUniqueOrThrow({ where: { id: doctor.profileId } })).version;

      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          request(app).patch('/doctors/me').set(asUser(doctor)).set('If-Match', etag).send({ fullName: `Racer ${i}` }),
        ),
      );

      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 412)).toHaveLength(7);
      for (const loser of responses.filter((r) => r.status === 412)) expect(loser.body.code).toBe('VERSION_CONFLICT');

      const stored = await prisma.doctorProfile.findUniqueOrThrow({ where: { id: doctor.profileId } });
      expect(stored.version).toBe(versionBefore + 1);
      expect(stored.fullName).toBe(responses.find((r) => r.status === 200)!.body.fullName);
    });

    it('authorises before checking the precondition, and validates the body', async () => {
      // No token -> 401, not a hint that this route has a precondition.
      expect((await request(app).patch('/doctors/me').send({ fullName: 'Anon' })).status).toBe(401);
      // Wrong role -> 403, likewise.
      expect((await request(app).patch('/doctors/me').set(asUser(patient)).send({ fullName: 'Patient' })).status).toBe(
        403,
      );

      const etag = (await request(app).get('/doctors/me').set(asUser(doctor))).headers.etag;
      const before = (await prisma.doctorProfile.findUniqueOrThrow({ where: { id: doctor.profileId } })).version;
      expect(
        (await request(app).patch('/doctors/me').set(asUser(doctor)).set('If-Match', etag).send({ fullName: '' })).status,
      ).toBe(400);
      expect(
        (
          await request(app)
            .patch('/doctors/me')
            .set(asUser(doctor))
            .set('If-Match', etag)
            .send({ fullName: 'Sneaky', verificationStatus: 'verified' })
        ).status,
      ).toBe(400);
      expect((await prisma.doctorProfile.findUniqueOrThrow({ where: { id: doctor.profileId } })).version).toBe(before);
    });
  });

  describe('already-conditional transitions are not given a second guard', () => {
    it('books without If-Match — the slot claim is already the guard', async () => {
      const res = await request(app)
        .post('/appointments')
        .set({ Authorization: `Bearer ${patient.token}` })
        .send({ availabilitySlotId: slotId });
      expect(res.status).toBe(201);
      expect((await prisma.appointment.findUniqueOrThrow({ where: { id: res.body.id } })).version).toBe(1);
    });

    it('flips doctor verification without If-Match and still bumps the version', async () => {
      const before = await prisma.doctorProfile.findUniqueOrThrow({ where: { id: otherDoctor.profileId } });
      const res = await request(app)
        .patch(`/doctors/${otherDoctor.profileId}/verification`)
        .set(adminAuth())
        .send({ status: 'verified' });
      expect(res.status).toBe(200);
      expect(res.body.verificationStatus).toBe('verified');
      expect(res.body.version).toBe(before.version + 1);
    });

    it('funds and releases without If-Match, advancing the version each time', async () => {
      const intent = await createIntent();
      expect(intent.version).toBe(1);

      const read = await request(app).get(`/payments/intents/${intent.id}`).set(adminAuth());
      expect(read.status).toBe(200);
      expect(read.headers.etag).toBe('"1"');
      expect(read.body.version).toBe(1);

      const funded = await request(app).post(`/payments/intents/${intent.id}/fund`).set(adminAuth());
      expect(funded.status).toBe(200);
      expect(funded.body.version).toBe(2);
      expect(funded.headers.etag).toBe('"2"');

      const released = await request(app).post(`/payments/intents/${intent.id}/release`).set(adminAuth());
      expect(released.status).toBe(200);
      expect(released.body.version).toBe(3);

      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).version).toBe(3);

      // The status transition's own conditional write is untouched: a second
      // release still loses on status (409), not on the version.
      expect((await request(app).post(`/payments/intents/${intent.id}/release`).set(adminAuth())).status).toBe(409);
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).version).toBe(3);
    });
  });

  describe('schema', () => {
    it('puts a version column on the mutable models and nothing else', async () => {
      const rows = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'version'
        ORDER BY table_name
      `;
      // Append-only Prescription/LabOrder and every immutable record
      // (Specialty, WalletLink, AuditEvent, the export tables) are absent by
      // design — see ARCHITECTURE.md §5.4.4.
      expect(rows.map((r) => r.table_name)).toEqual([
        'Appointment',
        'DoctorProfile',
        'FacilityCapability',
        'FacilityProfile',
        'PatientProfile',
        'PaymentIntent',
        'User',
      ]);
    });

    it('bumps the User version when the address is verified', async () => {
      const email = `cc-verify-${runId}@example.com`;
      const signupRes = await request(app)
        .post('/auth/signup')
        .send({ role: 'patient', email, password: 'longenough123', fullName: 'Verify Me' });
      expect(signupRes.status).toBe(200);
      const userId = signupRes.body.user.id as string;
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).version).toBe(1);

      expect((await request(app).post('/auth/verify-email').send({ token: emailedTokens.get(email) })).status).toBe(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).version).toBe(2);
    });
  });
});