// Integration tests for the AuditEvent foundation (Phase 8, issue #43),
// against the real transitions — not the audit service in isolation:
// booking, doctor verification and payment fund/release/refund each emit an
// event with the right actor/entity/action/states/request id; the event
// commits with its change and rolls back with it (failure injected by a real
// database trigger, not a mock); a transition that fails or loses a race
// emits nothing; metadata carries no PHI or secrets; the table is
// append-only at the database level; and GET /admin/audit-events filters
// and pages deterministically. Self-contained, same embedded-Postgres
// pattern as booking.test.mts. Own port (5441). The escrow SDK is faked —
// on-chain behaviour is the testnet suite's job.
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
const PORT = 5441;
const runId = Date.now();
const PAYER_SECRET = `SAUDITPAYERSENTINEL${runId}`;
const RELEASER_SECRET = `SAUDITRELEASERSENTINEL${runId}`;
const TX_HASH = 'c'.repeat(64);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-audit-pg-'));
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

const emailedTokens = new Map<string, string>();
const sdkBehaviour = { failRelease: false, nextEscrowId: 77n };
let escrowClientContractIds: string[] = [];

describe('AuditEvent foundation', () => {
  let app: App;
  let prisma: Prisma;
  let audit: typeof import('../../src/modules/audit/services/index.js');
  let admin: { id: string; token: string };
  let doctor: { userId: string; profileId: string; token: string };
  let patients: { userId: string; token: string; email: string }[];
  let facilityId: string;
  let slots: string[];

  async function signup(role: 'patient' | 'doctor', label: string) {
    const email = `${label}-${runId}@example.com`;
    const res = await request(app).post('/auth/signup').send({ role, email, password: 'longenough123', fullName: `${label} Fullname` });
    expect(res.status).toBe(200);
    expect((await request(app).post('/auth/verify-email').send({ token: emailedTokens.get(email) })).status).toBe(200);
    return { userId: res.body.user.id as string, token: res.body.accessToken as string, email };
  }

  /** A real DB-level failure in the audit insert, scoped to one entity type:
   * proves the state change rolls back with its event. */
  async function failAuditInsertsFor(entityType: string) {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."entityType" = '${entityType}' THEN RAISE EXCEPTION 'injected audit failure'; END IF;
        RETURN NEW;
      END; $$`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_fail_audit_insert BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION test_fail_audit_insert()`,
    );
    return async () => {
      await prisma.$executeRawUnsafe(`DROP TRIGGER test_fail_audit_insert ON "AuditEvent"`);
    };
  }

  const adminAuth = () => ({ Authorization: `Bearer ${admin.token}` });
  const listEvents = (query: Record<string, string | number>) =>
    request(app).get('/admin/audit-events').query(query).set(adminAuth());

  async function createIntent() {
    const patientProfileId = (await prisma.patientProfile.findFirstOrThrow()).id;
    const order = await createOrderFixture(prisma, { patientProfileId, facilityProfileId: facilityId, kind: 'lab_order', amountStroops: 5000n, tag: `audit-${Math.random()}` });
    return createPaymentIntentForFixture(prisma, order);
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
    process.env.PLATFORM_PAYER_SECRET = PAYER_SECRET;
    process.env.PLATFORM_RELEASER_SECRET = RELEASER_SECRET;
    process.env.ESCROW_CONTRACT_ID = 'CTESTCONTRACT';
    process.env.ESCROW_LEGACY_CONTRACT_IDS = 'CLEGACYCONTRACT';
    process.env.ESCROW_TOKEN_ID = 'CTESTTOKEN';

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    const paymentsServices = await import('../../src/modules/payments/services/index.js');
    audit = await import('../../src/modules/audit/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;
    authServices.setEmailSender(async (message) => {
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
    });

    escrowClientContractIds = [];
    class FakeEscrowClient {
      constructor(options: { contractId: string }) { escrowClientContractIds.push(options.contractId); }
      async createEscrow() {
        const escrowId = sdkBehaviour.nextEscrowId;
        sdkBehaviour.nextEscrowId += 1n;
        return { escrowId, txHash: TX_HASH };
      }
      async release() {
        if (sdkBehaviour.failRelease) throw new Error('simulated on-chain failure');
      }
      async refund() {}
    }
    paymentsServices.setEscrowSdkForTests({
      Keypair: { fromSecret: () => ({ publicKey: () => 'GPLATFORMRELEASERPUBLICKEY' }) },
      EscrowClient: FakeEscrowClient,
    } as unknown as import('../../src/modules/payments/services/index.js').EscrowSdkModule);

    const adminUser = await prisma.user.create({
      data: { email: `admin-${runId}@example.com`, passwordHash: 'x', role: 'admin', emailVerifiedAt: new Date() },
    });
    admin = { id: adminUser.id, token: jwt.sign({ sub: adminUser.id, role: 'admin' }, 'test-access-secret', { expiresIn: '15m' }) };

    const doctorUser = await signup('doctor', 'audit-doctor');
    doctor = { ...doctorUser, profileId: (await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doctorUser.userId } })).id };
    patients = await Promise.all(Array.from({ length: 5 }, (_, i) => signup('patient', `audit-patient-${i}`)));

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ date: tomorrow, startHour: 9, endHour: 12, slotLengthMinutes: 30 });
    slots = ((await request(app).get(`/availability/doctors/${doctor.profileId}/slots`)).body as { id: string }[]).map((s) => s.id);

    const facilityUser = await prisma.user.create({ data: { email: `lab-${runId}@example.com`, passwordHash: 'x', role: 'facility' } });
    facilityId = (await prisma.facilityProfile.create({ data: { userId: facilityUser.id, name: 'Audit Lab', type: 'lab' } })).id;
    await prisma.walletLink.create({ data: { facilityId, stellarPublicKey: `G${'A'.repeat(55)}` } });
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

  describe('appointment booking', () => {
    it('emits one event with actor, entity, states and the request id', async () => {
      const before = new Date();
      const res = await request(app)
        .post('/appointments')
        .set('Authorization', `Bearer ${patients[0]!.token}`)
        .set('X-Request-Id', `booking-req-${runId}`)
        .send({ availabilitySlotId: slots[0] });
      expect(res.status).toBe(201);
      expect(res.headers['x-request-id']).toBe(`booking-req-${runId}`);

      const events = await prisma.auditEvent.findMany({ where: { entityType: 'Appointment', entityId: res.body.id } });
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({
        actorUserId: patients[0]!.userId,
        actorRole: 'patient',
        action: 'appointment.booked',
        fromState: null,
        toState: 'scheduled',
        requestId: `booking-req-${runId}`,
        metadata: { availabilitySlotId: slots[0], doctorProfileId: doctor.profileId, origin: 'direct_booking' },
      });
      // The DB timestamp comes from the transaction; allow for clock skew
      // between the test process and Postgres of a few seconds.
      expect(Math.abs(event!.createdAt.getTime() - before.getTime())).toBeLessThan(5_000);
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(patients[0]!.email);
      expect(serialized).not.toContain('Fullname');
    });

    it('mints a request id when none (or a malformed one) is sent', async () => {
      const res = await request(app)
        .post('/appointments')
        .set('Authorization', `Bearer ${patients[1]!.token}`)
        .set('X-Request-Id', 'bad id!')
        .send({ availabilitySlotId: slots[1] });
      expect(res.status).toBe(201);
      const event = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: res.body.id } });
      expect(event.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers['x-request-id']).toBe(event.requestId);
    });

    it('records exactly one event when concurrent bookings race — losers record nothing', async () => {
      const slot = slots[2]!;
      const responses = await Promise.all(
        patients.map((p) => request(app).post('/appointments').set('Authorization', `Bearer ${p.token}`).send({ availabilitySlotId: slot })),
      );
      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(patients.length - 1);
      const appointment = await prisma.appointment.findUniqueOrThrow({ where: { availabilitySlotId: slot } });
      expect(await prisma.auditEvent.count({ where: { action: 'appointment.booked', metadata: { path: ['availabilitySlotId'], equals: slot } } })).toBe(1);
      expect(await prisma.auditEvent.count({ where: { entityId: appointment.id } })).toBe(1);
    });

    it('rolls the booking back when its audit write fails — no orphan event, no orphan booking', async () => {
      const slot = slots[3]!;
      const restore = await failAuditInsertsFor('Appointment');
      try {
        const res = await request(app).post('/appointments').set('Authorization', `Bearer ${patients[1]!.token}`).send({ availabilitySlotId: slot });
        expect(res.status).toBe(500);
      } finally {
        await restore();
      }
      expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slot } })).status).toBe('open');
      expect(await prisma.appointment.count({ where: { availabilitySlotId: slot } })).toBe(0);
      // And with the failure removed, the same slot books normally.
      const retry = await request(app).post('/appointments').set('Authorization', `Bearer ${patients[1]!.token}`).send({ availabilitySlotId: slot });
      expect(retry.status).toBe(201);
      expect(await prisma.auditEvent.count({ where: { entityId: retry.body.id } })).toBe(1);
    });
  });

  describe('doctor verification', () => {
    const patch = (status: string, requestIdHeader?: string) => {
      const req = request(app).patch(`/doctors/${doctor.profileId}/verification`).set(adminAuth());
      if (requestIdHeader) req.set('X-Request-Id', requestIdHeader);
      return req.send({ status });
    };

    it('records who changed it and the real previous and new states', async () => {
      expect((await patch('verified', `verify-req-${runId}`)).status).toBe(200);
      expect((await patch('rejected')).status).toBe(200);
      const events = await prisma.auditEvent.findMany({
        where: { entityType: 'DoctorProfile', entityId: doctor.profileId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(events.map((e) => [e.fromState, e.toState])).toEqual([
        ['pending', 'verified'],
        ['verified', 'rejected'],
      ]);
      expect(events[0]).toMatchObject({
        actorUserId: admin.id,
        actorRole: 'admin',
        action: 'doctor.verification_status_changed',
        requestId: `verify-req-${runId}`,
        metadata: null,
      });
    });

    it('records nothing when the status is unchanged', async () => {
      const before = await prisma.auditEvent.count({ where: { entityId: doctor.profileId } });
      expect((await patch('rejected')).status).toBe(200);
      expect(await prisma.auditEvent.count({ where: { entityId: doctor.profileId } })).toBe(before);
    });

    it('rolls the status change back when its audit write fails', async () => {
      const restore = await failAuditInsertsFor('DoctorProfile');
      try {
        expect((await patch('verified')).status).toBe(500);
      } finally {
        await restore();
      }
      expect((await prisma.doctorProfile.findUniqueOrThrow({ where: { id: doctor.profileId } })).verificationStatus).toBe('rejected');
    });
  });

  describe('payment fund / release / refund', () => {
    const post = (intentId: string, action: 'fund' | 'release' | 'refund') =>
      request(app).post(`/payments/intents/${intentId}/${action}`).set(adminAuth()).set('X-Request-Id', `pay-${action}-${runId}`);

    it('records created -> escrowed -> released with on-chain references and no secrets', async () => {
      const intent = await createIntent();
      expect((await post(intent.id, 'fund')).status).toBe(200);
      expect((await post(intent.id, 'release')).status).toBe(200);
      const events = await prisma.auditEvent.findMany({ where: { entityId: intent.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      expect(events.map((e) => [e.action, e.fromState, e.toState])).toEqual([
        ['payment_intent.funded', 'created', 'escrowed'],
        ['payment_intent.released', 'escrowed', 'released'],
      ]);
      expect(events[0]).toMatchObject({
        actorUserId: admin.id,
        actorRole: 'admin',
        requestId: `pay-fund-${runId}`,
        metadata: { orderType: 'lab_order', orderId: intent.labOrderId, amount: '5000', assetCode: 'XLM', stellarTxHash: TX_HASH, sorobanContractId: 'CTESTCONTRACT' },
      });
      expect((events[0]!.metadata as Record<string, unknown>).escrowId).toMatch(/^\d+$/);
      const serialized = JSON.stringify(events);
      for (const secret of [PAYER_SECRET, RELEASER_SECRET, 'GPLATFORMRELEASERPUBLICKEY']) expect(serialized).not.toContain(secret);
    });

    it('uses the payment intent recorded legacy contract for release', async () => {
      const intent = await createIntent();
      await post(intent.id, 'fund');
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { sorobanContractId: 'CLEGACYCONTRACT' } });
      expect((await post(intent.id, 'release')).status).toBe(200);
      expect(escrowClientContractIds.slice(-2)).toEqual(['CTESTCONTRACT', 'CLEGACYCONTRACT']);
    });

    it('records escrowed -> refunded', async () => {
      const intent = await createIntent();
      await post(intent.id, 'fund');
      expect((await post(intent.id, 'refund')).status).toBe(200);
      const refund = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: intent.id, action: 'payment_intent.refunded' } });
      expect([refund.fromState, refund.toState]).toEqual(['escrowed', 'refunded']);
    });

    it('records nothing when the operation fails — no invented transition', async () => {
      const intent = await createIntent();
      await post(intent.id, 'fund');
      sdkBehaviour.failRelease = true;
      try {
        expect((await post(intent.id, 'release')).status).toBe(500);
      } finally {
        sdkBehaviour.failRelease = false;
      }
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('escrowed');
      expect(await prisma.auditEvent.count({ where: { entityId: intent.id, action: 'payment_intent.released' } })).toBe(0);
      // An invalid transition is refused before anything happens, too.
      expect((await post(intent.id, 'fund')).status).toBe(409);
      expect(await prisma.auditEvent.count({ where: { entityId: intent.id } })).toBe(1);
    });

    it('records one release when two race for the same intent', async () => {
      const intent = await createIntent();
      await post(intent.id, 'fund');
      const [a, b] = await Promise.all([post(intent.id, 'release'), post(intent.id, 'refund')]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const finalStatus = (await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status;
      const terminal = await prisma.auditEvent.findMany({ where: { entityId: intent.id, action: { in: ['payment_intent.released', 'payment_intent.refunded'] } } });
      expect(terminal).toHaveLength(1);
      expect(terminal[0]!.toState).toBe(finalStatus);
    });

    it('rolls the status change back when its audit write fails', async () => {
      const intent = await createIntent();
      const restore = await failAuditInsertsFor('PaymentIntent');
      try {
        expect((await post(intent.id, 'fund')).status).toBe(500);
      } finally {
        await restore();
      }
      expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('created');
      expect(await prisma.auditEvent.count({ where: { entityId: intent.id } })).toBe(0);
    });
  });

  describe('append-only', () => {
    it('has no update path, and no delete beyond access-log retention', async () => {
      const repo = await import('../../src/modules/audit/repositories/index.js');
      // AuditEvent: INSERT + SELECT only (the DB triggers below enforce the
      // rest). AccessLog (issue #45) is a different table with its own
      // retention: `pruneAccessLogs` is the one deliberate delete, bounded
      // to rows older than the retention window — never an arbitrary one.
      expect(Object.keys(repo).sort()).toEqual([
        'findAccessByEntity',
        'findAccessByUser',
        'findAccessForPatient',
        'findAuditEvents',
        'insertAuditEvent',
        'pruneAccessLogs',
        'recordAccess',
      ]);
    });

    it('rejects UPDATE, DELETE and TRUNCATE at the database level', async () => {
      const event = await prisma.auditEvent.findFirstOrThrow();
      const count = await prisma.auditEvent.count();
      await expect(prisma.auditEvent.update({ where: { id: event.id }, data: { action: 'tampered.action' } })).rejects.toThrow(/append-only/);
      await expect(prisma.auditEvent.updateMany({ data: { toState: 'x' } })).rejects.toThrow(/append-only/);
      await expect(prisma.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append-only/);
      await expect(prisma.auditEvent.deleteMany()).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRawUnsafe('TRUNCATE "AuditEvent"')).rejects.toThrow(/append-only/);
      expect(await prisma.auditEvent.count()).toBe(count);
      expect(await prisma.auditEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(event);
    });

    it('refuses to record outside a transaction', async () => {
      await expect(
        audit.record(prisma as never, audit.SYSTEM_ACTOR, { entityType: 'Appointment', entityId: 'x', action: 'appointment.booked', fromState: null, toState: 'scheduled' }),
      ).rejects.toThrow(/inside the transaction/);
    });
  });

  describe('GET /admin/audit-events', () => {
    it('is admin-only', async () => {
      expect((await request(app).get('/admin/audit-events')).status).toBe(401);
      expect((await request(app).get('/admin/audit-events').set('Authorization', `Bearer ${patients[0]!.token}`)).status).toBe(403);
      expect((await request(app).get('/admin/audit-events').set('Authorization', `Bearer ${doctor.token}`)).status).toBe(403);
      expect((await request(app).get('/admin/audit-events').set(adminAuth())).status).toBe(200);
    });

    it('filters by entity, actor and date range', async () => {
      const appointments = await listEvents({ entityType: 'Appointment', limit: 200 });
      expect(appointments.status).toBe(200);
      expect(appointments.body.items.length).toBeGreaterThan(0);
      expect(appointments.body.items.every((e: { entityType: string }) => e.entityType === 'Appointment')).toBe(true);

      const one = await listEvents({ entityType: 'DoctorProfile', entityId: doctor.profileId });
      expect(one.body.items.map((e: { toState: string }) => e.toState)).toEqual(['rejected', 'verified']);

      const byAdmin = await listEvents({ actorUserId: admin.id, limit: 200 });
      expect(byAdmin.body.items.length).toBeGreaterThan(0);
      expect(byAdmin.body.items.every((e: { actorUserId: string }) => e.actorUserId === admin.id)).toBe(true);
      const byPatient = await listEvents({ actorUserId: patients[0]!.userId });
      expect(byPatient.body.items.every((e: { actorUserId: string }) => e.actorUserId === patients[0]!.userId)).toBe(true);

      const all = (await listEvents({ limit: 200 })).body.items as { createdAt: string }[];
      const pivot = all[Math.floor(all.length / 2)]!.createdAt;
      const after = (await listEvents({ from: pivot, limit: 200 })).body.items as { createdAt: string }[];
      const before = (await listEvents({ to: pivot, limit: 200 })).body.items as { createdAt: string }[];
      expect(after.every((e) => e.createdAt >= pivot)).toBe(true);
      expect(before.every((e) => e.createdAt <= pivot)).toBe(true);
      expect(new Set([...after, ...before].map((e) => JSON.stringify(e))).size).toBe(all.length);
      expect((await listEvents({ from: '2999-01-01' })).body).toEqual({ items: [], nextCursor: null });
    });

    it('validates the query', async () => {
      const invalid: Record<string, string | number>[] = [
        { limit: 0 },
        { limit: 500 },
        { from: 'not-a-date' },
        { unknown: 'x' },
        { entityId: 'a' },
        { cursor: 'garbage' },
        { from: '2026-10-17', to: '2026-10-01' },
      ];
      for (const query of invalid) {
        const res = await listEvents(query);
        expect(res.status, JSON.stringify(query)).toBe(400);
      }
    });

    it('pages with a stable cursor: every event once, in a total order, even with identical timestamps', async () => {
      // 23 events with one identical createdAt (Prisma stamps createdAt per
      // row on the client, so real same-millisecond writes collide like
      // this) — the cursor must tie-break on id. Inserted directly: INSERT
      // is the one operation the append-only trigger allows.
      const entityId = `bulk-${runId}`;
      const sameInstant = new Date('2026-01-01T00:00:00.000Z');
      await prisma.auditEvent.createMany({
        data: Array.from({ length: 23 }, (_, i) => ({
          entityType: 'PaymentIntent',
          entityId,
          action: 'payment_intent.funded',
          fromState: 'created',
          toState: 'escrowed',
          metadata: { seq: i },
          createdAt: sameInstant,
        })),
      });
      const rows = await prisma.auditEvent.findMany({ where: { entityId } });
      expect(new Set(rows.map((r) => r.createdAt.getTime())).size).toBe(1);

      const collect = async () => {
        const seen: { id: string; createdAt: string }[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const res = await listEvents({ entityType: 'PaymentIntent', entityId, limit: 5, ...(cursor ? { cursor } : {}) });
          expect(res.status).toBe(200);
          expect(res.body.items.length).toBeLessThanOrEqual(5);
          seen.push(...res.body.items);
          cursor = res.body.nextCursor;
          pages += 1;
          // A newer event arriving mid-scan must not disturb the remaining pages.
          if (pages === 2) {
            await prisma.$transaction((tx) => audit.record(tx, audit.SYSTEM_ACTOR, { entityType: 'PaymentIntent', entityId, action: 'payment_intent.released', fromState: 'escrowed', toState: 'released' }));
          }
        } while (cursor);
        return { seen, pages };
      };

      const { seen, pages } = await collect();
      expect(pages).toBe(5);
      expect(seen).toHaveLength(23);
      expect(new Set(seen.map((e) => e.id)).size).toBe(23);
      const expected = rows.map((r) => r.id).sort().reverse();
      expect(seen.map((e) => e.id)).toEqual(expected);

      // Deterministic: a second full scan sees the same 23 (plus the newer one, first).
      const again = await collect();
      expect(again.seen.slice(1).map((e) => e.id)).toEqual(expected);
      expect(again.seen[0]!.id).not.toBe(expected[0]);
    });
  });

  it('keeps the existing booking guarantee: every booked slot has exactly one appointment', async () => {
    const booked = await prisma.availabilitySlot.findMany({ where: { doctorProfileId: doctor.profileId, status: 'booked' } });
    for (const slot of booked) expect(await prisma.appointment.count({ where: { availabilitySlotId: slot.id } })).toBe(1);
  });
});
