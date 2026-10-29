// Integration tests for `Idempotency-Key` replay protection (Phase 8, issue
// #48), against a real Postgres — because the guarantee lives in the database.
//
// A retry of a booking or a payment must return the first response instead of
// running the mutation again, a retry that carries a *different* body must be
// refused, and two requests arriving at the same instant with the same key must
// not both run. The last one is the point: none of this is provable against a
// mock, because the thing under test is the unique index on (userId, key)
// deciding ownership between two concurrent writers.
//
// Covered here:
//   - replay of a completed POST /appointments and POST /payments/intents
//   - 422 when one key is reused for a different body / target id
//   - 409 IN_PROGRESS while a request with the same key is still running,
//     proven deterministically against a handler held open by a gate, plus a
//     genuine simultaneous burst (8 concurrent requests, one key)
//   - keys are scoped per user: a second account reusing the first account's
//     key string runs its own request and never sees the first response
//   - a retried fund/release/refund replays instead of making a second escrow
//     call (the fake SDK counts calls — this is the payments half of #48, and
//     what issue #24's reconcile job would otherwise have to clean up)
//   - 5xx is NOT cached: the client can retry the same key and have it run
//   - an attempt left unfinished by a dead process is taken over, but only by
//     an identical request
//   - unopted-in routes are untouched, and a malformed key is a 400
//
// Self-contained embedded Postgres on its own port (5443), same pattern as the
// other files in this directory, so it runs alongside them. The escrow SDK is
// faked — on-chain behaviour is the testnet suite's job.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import EmbeddedPostgres from 'embedded-postgres';
import { createOrderFixture, createPaymentIntentForFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5443;
const runId = Date.now();
const PAYER_SECRET = `IDEMPAYERSENTINEL${runId}`;
const RELEASER_SECRET = `IDEMRELEASERSENTINEL${runId}`;
const TX_HASH = 'd'.repeat(64);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-idempotency-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

// Small enough that the "oversized response" route below exceeds it and the
// ordinary booking/intent responses (a few hundred bytes) do not. Read from
// config at import time, so it has to be set before the dynamic imports.
const MAX_CACHED_BODY_BYTES = 1024;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

const emailedTokens = new Map<string, string>();

// Every call the fake SDK receives, so a test can assert that a replayed
// payment request did NOT reach the chain a second time.
const sdkCalls = { createEscrow: 0, release: 0, refund: 0 };

describe('Idempotency-Key replay protection', () => {
  let app: App;
  let prisma: Prisma;
  let idempotency: typeof import('../../src/middleware/idempotency.js');
  let errorHandler: typeof import('../../src/middleware/error-handler.js').errorHandler;
  let admin: { id: string; token: string };
  let doctor: { userId: string; profileId: string; token: string };
  let patients: { userId: string; token: string; email: string }[];
  let facilityId: string;
  let slots: string[];
  let patientProfileId: string;

  async function signup(role: 'patient' | 'doctor', label: string) {
    const email = `${label}-${runId}@example.com`;
    const res = await request(app).post('/auth/signup').send({ role, email, password: 'longenough123', fullName: `${label} Fullname` });
    expect(res.status).toBe(200);
    const token = emailedTokens.get(email);
    expect(token, `no verification email captured for ${email}`).toBeTruthy();
    expect((await request(app).post('/auth/verify-email').send({ token })).status).toBe(200);
    return { userId: res.body.user.id as string, token: res.body.accessToken as string, email };
  }

  const asPatient = (index: number) => ({ Authorization: `Bearer ${patients[index]!.token}` });
  const asAdmin = () => ({ Authorization: `Bearer ${admin.token}` });

  const rowFor = (userId: string, key: string) => prisma.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
  const appointmentCount = (slotId: string) => prisma.appointment.count({ where: { availabilitySlotId: slotId } });

  async function bookSlot(slotId: string, key?: string, patientIndex = 0) {
    const req = request(app).post('/appointments').set(asPatient(patientIndex)).send({ availabilitySlotId: slotId });
    return key === undefined ? req : req.set('Idempotency-Key', key);
  }

  const postPaymentAction = (id: string, action: string, headers: Record<string, string> = {}) =>
    request(app).post(`/payments/intents/${id}/${action}`).set(asAdmin()).set(headers).send({});

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
    process.env.PLATFORM_PAYER_SECRET = PAYER_SECRET;
    process.env.PLATFORM_RELEASER_SECRET = RELEASER_SECRET;
    process.env.ESCROW_CONTRACT_ID = 'CTESTCONTRACT';
    process.env.ESCROW_TOKEN_ID = 'CTESTTOKEN';
    process.env.IDEMPOTENCY_MAX_CACHED_BODY_BYTES = String(MAX_CACHED_BODY_BYTES);

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    const paymentsServices = await import('../../src/modules/payments/services/index.js');
    idempotency = await import('../../src/middleware/idempotency.js');
    errorHandler = (await import('../../src/middleware/error-handler.js')).errorHandler;
    app = appModule.createApp();
    prisma = dbModule.prisma;

    authServices.setEmailSender(async (message) => {
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
    });

    class FakeEscrowClient {
      async createEscrow() {
        sdkCalls.createEscrow += 1;
        return { escrowId: BigInt(1000 + sdkCalls.createEscrow), txHash: TX_HASH };
      }
      async release() {
        sdkCalls.release += 1;
      }
      async refund() {
        sdkCalls.refund += 1;
      }
    }
    paymentsServices.setEscrowSdkForTests({
      Keypair: { fromSecret: () => ({ publicKey: () => 'GPLATFORMRELEASERPUBLICKEY' }) },
      EscrowClient: FakeEscrowClient,
    } as unknown as import('../../src/modules/payments/services/index.js').EscrowSdkModule);

    const adminUser = await prisma.user.create({
      data: { email: `admin-${runId}@example.com`, passwordHash: 'x', role: 'admin', emailVerifiedAt: new Date() },
    });
    admin = { id: adminUser.id, token: jwt.sign({ sub: adminUser.id, role: 'admin' }, 'test-access-secret', { expiresIn: '15m' }) };

    const doctorUser = await signup('doctor', 'idem-doctor');
    doctor = { ...doctorUser, profileId: (await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doctorUser.userId } })).id };
    patients = await Promise.all(Array.from({ length: 3 }, (_, i) => signup('patient', `idem-patient-${i}`)));
    patientProfileId = (await prisma.patientProfile.findFirstOrThrow({ where: { userId: patients[0]!.userId } })).id;

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ date: tomorrow, startHour: 9, endHour: 14, slotLengthMinutes: 30 });
    slots = ((await request(app).get(`/availability/doctors/${doctor.profileId}/slots`)).body as { id: string }[]).map((s) => s.id);
    expect(slots.length).toBeGreaterThanOrEqual(8);

    const facilityUser = await prisma.user.create({ data: { email: `lab-${runId}@example.com`, passwordHash: 'x', role: 'facility' } });
    facilityId = (await prisma.facilityProfile.create({ data: { userId: facilityUser.id, name: 'Idempotency Lab', type: 'lab' } })).id;
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

  beforeEach(async () => {
    // Only the idempotency bookkeeping is reset between tests — appointments,
    // intents and slots accumulate, and every assertion is scoped to the row it
    // is about.
    await prisma.idempotencyKey.deleteMany();
    sdkCalls.createEscrow = 0;
    sdkCalls.release = 0;
    sdkCalls.refund = 0;
  });

  describe('POST /appointments', () => {
    it('replays the stored response to a retry instead of booking twice', async () => {
      const key = `book-replay-${runId}`;

      const first = await bookSlot(slots[0]!, key);
      expect(first.status).toBe(201);
      expect(first.headers['idempotency-replayed']).toBeUndefined();

      // Same key, same body — the patient tapping "retry" after a timeout.
      const retry = await bookSlot(slots[0]!, key);
      expect(retry.status).toBe(201);
      expect(retry.headers['idempotency-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);

      // One request ran, not two: one Appointment, one slot claim, one audit
      // event. A replay is a read, never a second execution.
      expect(await appointmentCount(slots[0]!)).toBe(1);
      expect(await prisma.auditEvent.count({ where: { entityType: 'Appointment', entityId: first.body.id } })).toBe(1);

      const row = await rowFor(patients[0]!.userId, key);
      expect(row).toMatchObject({ userId: patients[0]!.userId, key, method: 'POST', route: '/appointments' });
      expect(row!.responseStatus).toBe(201);
      expect(row!.responseBody).toEqual(first.body);
      expect(row!.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('refuses the same key with a different body (422) and runs nothing', async () => {
      const key = `book-mismatch-${runId}`;
      expect((await bookSlot(slots[1]!, key)).status).toBe(201);

      const mismatch = await bookSlot(slots[2]!, key);
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

      // The refused request never reached the handler: slot 2 is still open and
      // holds no appointment.
      expect(await appointmentCount(slots[2]!)).toBe(0);
      expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slots[2]! } })).status).toBe('open');
    });

    it('rejects a malformed key with 400 before anything runs', async () => {
      const bad = await bookSlot(slots[3]!, 'has a space in it');
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('INVALID_IDEMPOTENCY_KEY');

      expect(await appointmentCount(slots[3]!)).toBe(0);
      expect(await prisma.idempotencyKey.count()).toBe(0);
    });

    it('does not touch a route that has not opted in', async () => {
      const res = await request(app)
        .get('/appointments/mine')
        .set(asPatient(0))
        .set('Idempotency-Key', `not-opted-in-${runId}`);
      expect(res.status).toBe(200);
      expect(await prisma.idempotencyKey.count()).toBe(0);
    });
  });

  describe('simultaneous requests', () => {
    it('runs one of 8 identical booking requests and refuses or replays the other 7', async () => {
      const key = `book-race-${runId}`;

      const responses = await Promise.all(Array.from({ length: 8 }, () => bookSlot(slots[4]!, key)));

      // Exactly one attempt was executed: one idempotency row, and the slot
      // was claimed exactly once.
      expect(await prisma.idempotencyKey.count()).toBe(1);
      expect(await appointmentCount(slots[4]!)).toBe(1);

      const created = responses.filter((res) => res.status === 201);
      expect(created.length).toBeGreaterThanOrEqual(1);

      // Every loser is either a 409 that says why, or a replay of the winner's
      // exact response. Nothing else is an acceptable outcome, and no two
      // distinct appointments were ever handed to the client.
      for (const res of responses) {
        if (res.status === 409) {
          expect(res.body.code).toBe('IN_PROGRESS');
          expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        } else {
          expect(res.status).toBe(201);
          expect(res.body).toEqual(created[0]!.body);
        }
      }
      expect(new Set(created.map((res) => res.body.id)).size).toBe(1);
    });

  });

  describe('per-user scoping', () => {
    it('gives each user their own attempt under the same key string', async () => {
      // Two different patients pick the *same* key value. A key is not a
      // credential, and one account must never be able to replay (or read)
      // another account's stored response.
      const key = `shared-key-${runId}`;

      const a = await bookSlot(slots[5]!, key, 0);
      const b = await bookSlot(slots[6]!, key, 1);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body.id).not.toBe(b.body.id);

      // Two rows, one per user — the unique index is on (userId, key), not key.
      expect(await prisma.idempotencyKey.count({ where: { key } })).toBe(2);

      // Each user's retry replays *their own* response, never the other's.
      const aRetry = await bookSlot(slots[5]!, key, 0);
      const bRetry = await bookSlot(slots[6]!, key, 1);
      expect(aRetry.body).toEqual(a.body);
      expect(bRetry.body).toEqual(b.body);
      expect(JSON.stringify(aRetry.body)).not.toContain(b.body.id);
      expect(JSON.stringify(bRetry.body)).not.toContain(a.body.id);
    });

    it('never hands one user a stored response that belongs to another', async () => {
      const key = `cross-user-${runId}`;
      // Patient 0 books under this key...
      const booking = await bookSlot(slots[7]!, key, 0);
      expect(booking.status).toBe(201);

      // ...and an admin reuses the same key string on a different route. It is
      // a different attempt, not a replay, and certainly not patient 0's body.
      const adminOrder = await createOrderFixture(prisma, { patientProfileId, facilityProfileId: facilityId, kind: 'lab_order', amountStroops: 5000n, tag: `cross-user-order-${runId}` });
      const adminIntent = await createPaymentIntentForFixture(prisma, adminOrder, 'created');
      const adminAttempt = await postPaymentAction(adminIntent.id, 'fund', { 'Idempotency-Key': key });
      expect(adminAttempt.status).toBe(200);
      expect(JSON.stringify(adminAttempt.body)).not.toContain(booking.body.id);

      const adminRetry = await postPaymentAction(adminIntent.id, 'fund', { 'Idempotency-Key': key });
      expect(adminRetry.status).toBe(200);
      expect(adminRetry.headers['idempotency-replayed']).toBe('true');
      expect(adminRetry.body).toEqual(adminAttempt.body);

      // The patient's row still holds the patient's response, untouched.
      const patientRow = await rowFor(patients[0]!.userId, key);
      expect(patientRow!.responseBody).toEqual(booking.body);
      expect(await prisma.idempotencyKey.count({ where: { key } })).toBe(2);
    });
  });

  describe('payments', () => {
    async function createIntent(orderId: string) {
      const order = await createOrderFixture(prisma, {
        patientProfileId,
        facilityProfileId: facilityId,
        kind: 'lab_order',
        amountStroops: 5000n,
        tag: orderId,
      });
      const intent = await createPaymentIntentForFixture(prisma, order, 'created');
      return { id: intent.id, status: intent.status } as { id: string; status: string };
    }

    it('treats the same key against a different intent id as a different request', async () => {
      const first = await createIntent(`cross-target-a-${runId}`);
      const second = await createIntent(`cross-target-b-${runId}`);
      const key = `fund-cross-target-${runId}`;

      expect((await postPaymentAction(first.id, 'fund', { 'Idempotency-Key': key })).status).toBe(200);

      // Same key, same (empty) body, different :id. Replaying the first
      // intent's response here would be a lie about a different record.
      const wrongTarget = await postPaymentAction(second.id, 'fund', { 'Idempotency-Key': key });
      expect(wrongTarget.status).toBe(422);
      expect(wrongTarget.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

      // Refused before any chain call: the second intent is untouched.
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('created');
      expect(sdkCalls.createEscrow).toBe(1);
    });

    it('replays fund/release/refund without calling the chain twice', async () => {
      const funded = await createIntent(`escrow-order-${runId}`);

      const fundKey = `fund-${runId}`;
      const firstFund = await postPaymentAction(funded.id, 'fund', { 'Idempotency-Key': fundKey });
      expect(firstFund.status).toBe(200);
      expect(firstFund.body.status).toBe('escrowed');
      expect(sdkCalls.createEscrow).toBe(1);

      // The retry a dropped connection causes must not push a second Stellar
      // transaction — exactly the mess issue #24's reconcile job would have to
      // clean up afterwards.
      const fundRetry = await postPaymentAction(funded.id, 'fund', { 'Idempotency-Key': fundKey });
      expect(fundRetry.status).toBe(200);
      expect(fundRetry.headers['idempotency-replayed']).toBe('true');
      expect(fundRetry.body).toEqual(firstFund.body);
      expect(sdkCalls.createEscrow).toBe(1);

      const releaseKey = `release-${runId}`;
      const firstRelease = await postPaymentAction(funded.id, 'release', { 'Idempotency-Key': releaseKey });
      expect(firstRelease.status).toBe(200);
      expect(firstRelease.body.status).toBe('released');
      expect(sdkCalls.release).toBe(1);

      const releaseRetry = await postPaymentAction(funded.id, 'release', { 'Idempotency-Key': releaseKey });
      expect(releaseRetry.status).toBe(200);
      expect(releaseRetry.headers['idempotency-replayed']).toBe('true');
      expect(releaseRetry.body).toEqual(firstRelease.body);
      expect(sdkCalls.release).toBe(1);

      // Refund runs against its own intent, so release's replay can't leak into
      // it — and the refund's own retry is likewise exactly one chain call.
      const refundable = await createIntent(`refund-order-${runId}`);
      expect((await postPaymentAction(refundable.id, 'fund')).status).toBe(200);

      const refundKey = `refund-${runId}`;
      const firstRefund = await postPaymentAction(refundable.id, 'refund', { 'Idempotency-Key': refundKey });
      expect(firstRefund.status).toBe(200);
      expect(firstRefund.body.status).toBe('refunded');

      const refundRetry = await postPaymentAction(refundable.id, 'refund', { 'Idempotency-Key': refundKey });
      expect(refundRetry.status).toBe(200);
      expect(refundRetry.body).toEqual(firstRefund.body);
      expect(sdkCalls.refund).toBe(1);
    });

    it('caches a deterministic 4xx so a retry gets the same answer', async () => {
      const intent = await createIntent(`four-oh-four-order-${runId}`);
      // Fund it once (no key), then fund it again through the route: the 409 is
      // this key's answer, and replaying it is the useful behaviour.
      expect((await postPaymentAction(intent.id, 'fund')).status).toBe(200);
      expect(sdkCalls.createEscrow).toBe(1);

      const key = `already-funded-${runId}`;
      const first = await postPaymentAction(intent.id, 'fund', { 'Idempotency-Key': key });
      expect(first.status).toBe(409);

      const retry = await postPaymentAction(intent.id, 'fund', { 'Idempotency-Key': key });
      expect(retry.status).toBe(409);
      expect(retry.headers['idempotency-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      // Replaying an answer must never reach the chain.
      expect(sdkCalls.createEscrow).toBe(1);
    });
  });

  // A gated handler makes "one request is running" a fact this suite controls,
  // instead of a race it hopes to win. Same middleware, same database rows.
  describe('in-flight, failures and crash recovery', () => {
    let mini: express.Express;
    let userId: string;
    let handlerCalls: { slow: number; boom: number; huge: number };
    let hold: boolean;
    let release: () => void;

    beforeAll(() => {
      handlerCalls = { slow: 0, boom: 0, huge: 0 };
      hold = false;
      release = () => {};

      const miniApp = express();
      miniApp.use(express.json());
      // Stands in for `authenticate`: the middleware scopes keys by user, so
      // these tests need a user without needing a JWT.
      miniApp.use((req, _res, next) => {
        req.user = { id: userId, role: 'patient' };
        next();
      });

      miniApp.post('/slow/:id', idempotency.idempotency(), async (_req, res) => {
        handlerCalls.slow += 1;
        if (hold) await new Promise<void>((resolve) => (release = resolve));
        res.status(201).json({ created: true, at: handlerCalls.slow });
      });

      miniApp.post('/boom', idempotency.idempotency(), () => {
        handlerCalls.boom += 1;
        // Reaches the shared error handler: a 5xx, not a 4xx.
        throw new Error('simulated server error');
      });

      miniApp.post('/huge', idempotency.idempotency(), (_req, res) => {
        handlerCalls.huge += 1;
        res.status(200).json({ blob: 'x'.repeat(MAX_CACHED_BODY_BYTES * 2) });
      });

      miniApp.use(errorHandler);
      mini = miniApp;
    });

    beforeEach(async () => {
      await prisma.idempotencyKey.deleteMany();
      handlerCalls = { slow: 0, boom: 0, huge: 0 };
      hold = false;
      release = () => {};
      userId = patients[0]!.userId;
    });

    const slow = (body: unknown, key: string) => request(mini).post('/slow/1').set('Idempotency-Key', key).send(body as object);

    it('answers a concurrent duplicate with 409 IN_PROGRESS, then replays once it finishes', async () => {
      const key = `gate-${runId}`;
      hold = true;
      // `.then()` on a supertest Test is what actually starts the request, so
      // the gate has to be awaited through the returned promise, not the Test.
      const first = slow({ amount: 10 }, key).then((res) => res);

      // Wait until the winner is genuinely inside the handler.
      await vi.waitFor(() => expect(handlerCalls.slow).toBe(1));

      const loser = await slow({ amount: 10 }, key);
      expect(loser.status).toBe(409);
      expect(loser.body.code).toBe('IN_PROGRESS');
      expect(Number(loser.headers['retry-after'])).toBeGreaterThan(0);

      // A different body under the same key is refused even while the first is
      // in flight, so a colliding key can never redirect the running request.
      const mismatch = await slow({ amount: 11 }, key);
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

      release();
      const finished = await first;
      expect(finished.status).toBe(201);

      // Once it has finished, the same request replays instead of re-running.
      const replay = await slow({ amount: 10 }, key);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.body).toEqual(finished.body);
      expect(handlerCalls.slow).toBe(1);
    });

    it('never caches a 5xx, so the client can retry the same key', async () => {
      const key = `boom-${runId}`;
      const boom = () => request(mini).post('/boom').set('Idempotency-Key', key).send({});

      expect((await boom()).status).toBe(500);
      // A server error is not a result: the row is deleted, not cached.
      expect(await rowFor(userId, key)).toBeNull();

      // The client retries with the same key and the request runs again.
      expect((await boom()).status).toBe(500);
      expect(handlerCalls.boom).toBe(2);
      expect(await rowFor(userId, key)).toBeNull();
    });

    it('does not cache a response too large to replay', async () => {
      const key = `huge-${runId}`;
      const huge = () => request(mini).post('/huge').set('Idempotency-Key', key).send({});

      expect((await huge()).status).toBe(200);
      expect(await rowFor(userId, key)).toBeNull();

      // The retry re-executes rather than getting a body back that was dropped.
      expect((await huge()).status).toBe(200);
      expect(handlerCalls.huge).toBe(2);
    });

    it('takes over an attempt abandoned by a dead process — but only for the same request', async () => {
      const key = `stale-${runId}`;
      const body = { amount: 10 };
      const requestHash = idempotency.hashRequest('POST', '/slow/1', body);

      // What a process that died mid-request leaves behind: a claimed key with
      // no response, aged well past the crash-recovery window.
      await prisma.idempotencyKey.create({
        data: {
          userId,
          key,
          method: 'POST',
          route: '/slow/:id',
          requestHash,
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      // A different request under that key is still refused — a stale row must
      // never be re-pointed at a new operation.
      const mismatch = await slow({ amount: 99 }, key);
      expect(mismatch.status).toBe(422);
      expect(await rowFor(userId, key)).not.toBeNull();

      // The genuine retry runs and finishes the attempt.
      const takeover = await slow(body, key);
      expect(takeover.status).toBe(201);
      expect(handlerCalls.slow).toBe(1);

      const row = await rowFor(userId, key);
      expect(row!.responseStatus).toBe(201);
      expect(row!.requestHash).toBe(requestHash);
    });

    it('frees a key whose TTL has passed — a day-old answer is not replayed', async () => {
      const key = `expired-${runId}`;
      const body = { amount: 10 };
      await prisma.idempotencyKey.create({
        data: {
          userId,
          key,
          method: 'POST',
          route: '/slow/:id',
          requestHash: idempotency.hashRequest('POST', '/slow/1', body),
          responseStatus: 201,
          responseBody: { created: true, at: 'ancient' },
          createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() - 60 * 1000),
        },
      });

      const res = await slow(body, key);
      expect(res.status).toBe(201);
      // Executed, not replayed — the stale response is gone.
      expect(res.body.at).toBe(1);
      expect(handlerCalls.slow).toBe(1);
      expect((await rowFor(userId, key))!.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });
  });

  describe('retention', () => {
    it('prunes only rows past their TTL', async () => {
      const keep = `keep-${runId}`;
      const drop = `drop-${runId}`;
      const base = { userId: admin.id, method: 'POST', route: '/payments/intents', requestHash: 'a'.repeat(64) };
      await prisma.idempotencyKey.create({
        data: { ...base, key: keep, responseStatus: 201, createdAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
      });
      await prisma.idempotencyKey.create({
        data: { ...base, key: drop, responseStatus: 201, createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000), expiresAt: new Date(Date.now() - 60 * 1000) },
      });

      expect(await idempotency.pruneIdempotencyKeys()).toBe(1);
      expect((await prisma.idempotencyKey.findMany()).map((row) => row.key)).toEqual([keep]);
    });
  });
});
