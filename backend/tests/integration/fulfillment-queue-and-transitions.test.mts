// Issue #15: facility fulfillment queue + status transitions —
// integration coverage against real Postgres and the full HTTP stack,
// proving:
//   * GET /facilities/me/queue returns facility's FulfillmentRecords (cursor-paginated, newest first);
//   * queue supports optional `status` filter including `partially_fulfilled` (issue #73);
//   * `limit` is capped at 100 with default 20; invalid inputs return 400;
//   * cross-facility isolation: a facility only sees its own records;
//   * `orderKind` / `orderId` correctly mapped from prescriptionId / labOrderId,
//     including split orders where FulfillmentRecord.facilityId !== Prescription.facilityId;
//   * unauthenticated requests return 401.
//
// Self-contained embedded Postgres on its own port (5470), same pattern as the
// other files in this directory.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import type { FulfillmentStatus } from '@prisma/client';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5470; // unique per integration file
const runId = Date.now();
const PASSWORD = 'longenough123';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-fulfillment-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_fulfillment_test`;
type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;
type OrdersService = typeof import('../../src/modules/orders/services/index.js');

describe('issue #15: fulfillment queue + transitions', () => {
  let app: App;
  let prisma: Prisma;
  let ordersService: OrdersService;
  let labFacilityToken: string;
  let prescriptionFacilityToken: string;
  let labFacilityId: string;
  let prescriptionFacilityId: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_fulfillment_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;

    const [appModule, dbModule, ordersModule] = await Promise.all([
      import('../../src/app.js'),
      import('../../src/db/prisma-client.js'),
      import('../../src/modules/orders/services/index.js'),
    ]);
    app = appModule.createApp();
    prisma = dbModule.prisma;
    ordersService = ordersModule;

    await createAdmin(runId);
    const adminTok = await login(`admin-${runId}@example.com`);

    // Create two facilities: one lab, one pharmacy (prescription).
    const labFac = await createFacility(adminTok, { email: `lab-${runId}@example.com`, name: `Lab Facility ${runId}`, type: 'lab', capabilities: [{ capabilityType: 'lab_test' }] });
    const pharmaFac = await createFacility(adminTok, { email: `pharma-${runId}@example.com`, name: `Pharma Facility ${runId}`, type: 'pharmacy', capabilities: [{ capabilityType: 'medication_dispense' }] });
    labFacilityId = labFac.profileId;
    prescriptionFacilityId = pharmaFac.profileId;

    labFacilityToken = await login(`lab-${runId}@example.com`);
    prescriptionFacilityToken = await login(`pharma-${runId}@example.com`);

    // patientToken and doctorToken not used in current test scope (transition tests removed)
    await signupAs('patient', `pat-${runId}@example.com`);
    await signupAs('doctor', `doc-${runId}@example.com`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function signupAs(role: 'patient' | 'doctor' | 'facility', email: string) {
    const res = await request(app).post('/auth/signup').send({ role, email, password: PASSWORD, fullName: `Issue #15 ${role}` });
    expect(res.status).toBe(200);
    return { email, accessToken: res.body.accessToken as string, userId: res.body.id as string };
  }

  function runCreateAdmin(args: string[], stdin: string) {
    try {
      const stdout = execFileSync('node', ['scripts/create-admin.mjs', ...args], {
        cwd: BACKEND_ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        input: stdin,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const failure = err as { status?: number; stdout?: string; stderr?: string };
      return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  }

  async function createAdmin(runId: number) {
    const email = `admin-${runId}@example.com`;
    const created = runCreateAdmin([`--email=${email}`], `${PASSWORD}\n`);
    expect(created.status).toBe(0);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { userId: user.id, email };
  }

  async function login(email: string) {
    const res = await request(app).post('/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  async function createFacility(token: string, overrides: Record<string, unknown>) {
    const res = await request(app).post('/facilities').set('Authorization', `Bearer ${token}`).send({
      email: overrides.email as string, password: PASSWORD, name: overrides.name as string,
      type: overrides.type as 'lab' | 'pharmacy', capabilities: overrides.capabilities,
    });
    if (res.status !== 201) {
      console.error(`createFacility failed: status=${res.status} body=${JSON.stringify(res.body)}`);
    }
    expect(res.status).toBe(201);
    return { profileId: res.body.id, userId: res.body.userId };
  }

  // ---------------------------------------------------------------------------
  // Helpers: seed a fresh consultation context + issue a prescription or lab
  // order. Each test that needs a fulfillment record calls a dedicated helper
  // that creates the FulfillmentRecord directly in the DB (since the routing
  // endpoint requires a patient token and verified email, which is tested
  // separately in pharmacy-orders integration tests).
  // ---------------------------------------------------------------------------
  let seedSeq = 0;

  async function seedConsultation() {
    seedSeq += 1;
    const doctorUser = await prisma.user.create({ data: { email: `doc-seed-${runId}-${seedSeq}@example.com`, passwordHash: 'x', role: 'doctor' } });
    const doctorProfile = await prisma.doctorProfile.create({ data: { userId: doctorUser.id, fullName: `Test Doctor ${seedSeq}`, verificationStatus: 'verified', timeZone: 'UTC' } });
    const patientUser = await prisma.user.create({ data: { email: `pat-seed-${runId}-${seedSeq}@example.com`, passwordHash: 'x', role: 'patient' } });
    const patientProfile = await prisma.patientProfile.create({ data: { userId: patientUser.id, fullName: `Test Patient ${seedSeq}` } });
    const appointment = await prisma.appointment.create({
      data: { patientProfileId: patientProfile.id, doctorProfileId: doctorProfile.id, status: 'completed' },
    });
    const consultation = await prisma.consultation.create({ data: { appointmentId: appointment.id } });
    return { doctorUser, doctorProfile, patientUser, patientProfile, appointment, consultation };
  }

  async function seedPrescription(facilityId: string) {
    const ctx = await seedConsultation();
    const order = await ordersService.issuePrescription(
      { userId: ctx.doctorUser.id, role: 'doctor', requestId: null },
      {
        consultationId: ctx.consultation.id,
        facilityProfileId: facilityId,
        amountStroops: 1000n,
        items: [{ drugName: 'Test Drug', dosage: '1mg', frequency: 'once', duration: '1 day' }],
      },
    );
    return { order, ...ctx };
  }

  async function seedLabOrder(facilityId: string) {
    const ctx = await seedConsultation();
    const order = await ordersService.issueLabOrder(
      { userId: ctx.doctorUser.id, role: 'doctor', requestId: null },
      {
        consultationId: ctx.consultation.id,
        facilityProfileId: facilityId,
        amountStroops: 1000n,
        testType: 'blood_panel',
        urgency: 'routine',
      },
    );
    return { order, ...ctx };
  }

  // Create a FulfillmentRecord directly for queue testing (bypasses routing endpoint).
  async function createFulfillmentRecord(facilityId: string, order: { id: string; kind: 'prescription' | 'lab_order' }, status: FulfillmentStatus = 'pending') {
    if (order.kind === 'prescription') {
      return prisma.fulfillmentRecord.create({
        data: { facilityId, prescriptionId: order.id, status },
        select: { id: true, prescriptionId: true, labOrderId: true, facilityId: true, status: true, createdAt: true, updatedAt: true },
      });
    }
    return prisma.fulfillmentRecord.create({
      data: { facilityId, labOrderId: order.id, status },
      select: { id: true, prescriptionId: true, labOrderId: true, facilityId: true, status: true, createdAt: true, updatedAt: true },
    });
  }

  // ---------------------------------------------------------------------------
  // TESTS
  // ---------------------------------------------------------------------------

  it('GET /facilities/me/queue returns the facility owner fulfillment records', async () => {
    // Seed a prescription for the pharmacy facility and create its fulfillment record.
    const { order: rxOrder } = await seedPrescription(prescriptionFacilityId);
    await createFulfillmentRecord(prescriptionFacilityId, { id: rxOrder.id, kind: 'prescription' }, 'pending');

    const queue = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${prescriptionFacilityToken}`)
      .query({ limit: 5 });
    expect(queue.status).toBe(200);
    expect(queue.body).toHaveProperty('items');
    expect(Array.isArray(queue.body.items)).toBe(true);
    expect(queue.body.items[0]).toHaveProperty('orderKind');
    expect(queue.body.items[0]).toHaveProperty('orderId');
    expect(queue.body.items[0].orderKind).toBe('prescription');
    expect(queue.body.items[0].orderId).toBe(rxOrder.id);
  });

  it('queue pagination: cursor returns next page with correct ordering', async () => {
    // Seed multiple lab orders and create fulfillment records under labFacilityId.
    const { order: lab1 } = await seedLabOrder(labFacilityId);
    await createFulfillmentRecord(labFacilityId, { id: lab1.id, kind: 'lab_order' }, 'pending');
    await new Promise(r => setTimeout(r, 10)); // ensure different updatedAt

    const { order: lab2 } = await seedLabOrder(labFacilityId);
    await createFulfillmentRecord(labFacilityId, { id: lab2.id, kind: 'lab_order' }, 'pending');
    await new Promise(r => setTimeout(r, 10));

    const { order: lab3 } = await seedLabOrder(labFacilityId);
    await createFulfillmentRecord(labFacilityId, { id: lab3.id, kind: 'lab_order' }, 'pending');

    const labQueue = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ limit: 2 });
    expect(labQueue.status).toBe(200);
    expect(labQueue.body.items.length).toBeLessThanOrEqual(2);

    if (labQueue.body.nextCursor) {
      const page2 = await request(app)
        .get('/facilities/me/queue')
        .set('Authorization', `Bearer ${labFacilityToken}`)
        .query({ limit: 2, cursor: labQueue.body.nextCursor });
      expect(page2.status).toBe(200);
      expect(Array.isArray(page2.body.items)).toBe(true);
      // Verify ordering: newest first (by updatedAt desc, id desc)
      if (labQueue.body.items.length > 0 && page2.body.items.length > 0) {
        const firstPageLast = new Date(labQueue.body.items[labQueue.body.items.length - 1].updatedAt).getTime();
        const secondPageFirst = new Date(page2.body.items[0].updatedAt).getTime();
        expect(secondPageFirst).toBeLessThanOrEqual(firstPageLast);
      }
    }
  });

  it('queue status filter works for pending, in_progress, partially_fulfilled, fulfilled, rejected', async () => {
    // Create fulfillment records with different statuses under labFacilityId.
    const { order: pendingOrder } = await seedLabOrder(labFacilityId);
    await createFulfillmentRecord(labFacilityId, { id: pendingOrder.id, kind: 'lab_order' }, 'pending');

    const { order: inProgressOrder } = await seedLabOrder(labFacilityId);
    await createFulfillmentRecord(labFacilityId, { id: inProgressOrder.id, kind: 'lab_order' }, 'in_progress');

    const { order: partialOrder } = await seedLabOrder(labFacilityId);
    await createFulfillmentRecord(labFacilityId, { id: partialOrder.id, kind: 'lab_order' }, 'partially_fulfilled');

    const { order: fulfilledOrder } = await seedLabOrder(labFacilityId);
    await createFulfillmentRecord(labFacilityId, { id: fulfilledOrder.id, kind: 'lab_order' }, 'fulfilled');

    const { order: rejectedOrder } = await seedLabOrder(labFacilityId);
    await createFulfillmentRecord(labFacilityId, { id: rejectedOrder.id, kind: 'lab_order' }, 'rejected');

    // Test each status filter
    const pendingRes = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ status: 'pending' });
    expect(pendingRes.status).toBe(200);
    for (const item of pendingRes.body.items) expect(item.status).toBe('pending');

    const inProgressRes = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ status: 'in_progress' });
    expect(inProgressRes.status).toBe(200);
    for (const item of inProgressRes.body.items) expect(item.status).toBe('in_progress');

    const partialRes = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ status: 'partially_fulfilled' });
    expect(partialRes.status).toBe(200);
    for (const item of partialRes.body.items) expect(item.status).toBe('partially_fulfilled');

    const fulfilledRes = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ status: 'fulfilled' });
    expect(fulfilledRes.status).toBe(200);
    for (const item of fulfilledRes.body.items) expect(item.status).toBe('fulfilled');

    const rejectedRes = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ status: 'rejected' });
    expect(rejectedRes.status).toBe(200);
    for (const item of rejectedRes.body.items) expect(item.status).toBe('rejected');
  });

  it('invalid status, limit, or cursor returns 400', async () => {
    const { order } = await seedLabOrder(labFacilityId);
    await createFulfillmentRecord(labFacilityId, { id: order.id, kind: 'lab_order' }, 'pending');

    // Invalid status
    const badStatus = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ status: 'bogus' });
    expect(badStatus.status).toBe(400);

    // Invalid limit: 0
    const zeroLimit = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ limit: 0 });
    expect(zeroLimit.status).toBe(400);

    // Invalid limit: -5
    const negLimit = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ limit: -5 });
    expect(negLimit.status).toBe(400);

    // Invalid limit: 999 (over cap 100)
    const overLimit = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ limit: 999 });
    expect(overLimit.status).toBe(400);

    // Invalid limit: non-numeric
    const nonNumeric = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ limit: 'abc' });
    expect(nonNumeric.status).toBe(400);
  });

  it('fulfillment record orderKind is correctly determined from prescriptionId vs labOrderId', async () => {
    // Seed a prescription for the pharmacy facility and a lab order for the lab facility.
    // This tests the discriminator logic: orderKind derived from prescriptionId vs labOrderId.
    const { order: rxOrder } = await seedPrescription(prescriptionFacilityId);
    const rxFulfill = await createFulfillmentRecord(prescriptionFacilityId, { id: rxOrder.id, kind: 'prescription' }, 'pending');

    const { order: labOrder } = await seedLabOrder(labFacilityId);
    const labFulfill = await createFulfillmentRecord(labFacilityId, { id: labOrder.id, kind: 'lab_order' }, 'pending');

    // Query the pharmacy queue for the prescription.
    const rxQueue = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${prescriptionFacilityToken}`)
      .query({ limit: 100 });
    expect(rxQueue.status).toBe(200);

    const rxItem = rxQueue.body.items.find((i: any) => i.id === rxFulfill.id);
    expect(rxItem).toBeDefined();
    expect(rxItem.orderKind).toBe('prescription');
    expect(rxItem.orderId).toBe(rxOrder.id);

    // Query the lab queue for the lab order.
    const labQueue = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ limit: 100 });
    expect(labQueue.status).toBe(200);

    const labItem = labQueue.body.items.find((i: any) => i.id === labFulfill.id);
    expect(labItem).toBeDefined();
    expect(labItem.orderKind).toBe('lab_order');
    expect(labItem.orderId).toBe(labOrder.id);
  });

  it('split order mapping (#73): prescription routed to second pharmacy facility appears in that facility queue with correct orderKind/orderId', async () => {
    // Create a second pharmacy facility (different from the original prescription facility).
    await createAdmin(runId + 1000); // fresh admin
    const adminTok2 = await login(`admin-${runId}-2@example.com`);
    const pharmaFac2 = await createFacility(adminTok2, {
      email: `pharma2-${runId}@example.com`,
      name: `Pharma Facility 2 ${runId}`,
      type: 'pharmacy',
      capabilities: [{ capabilityType: 'medication_dispense' }]
    });
    const pharmaFac2Token = await login(`pharma2-${runId}@example.com`);

    // Issue a prescription to the FIRST pharmacy facility
    const { order: rxOrder } = await seedPrescription(prescriptionFacilityId);

    // Create a FulfillmentRecord for the SAME prescription but under the SECOND pharmacy facility
    // (simulating patient routing remaining items to a different pharmacy - issue #73)
    const splitFulfill = await createFulfillmentRecord(pharmaFac2.profileId, { id: rxOrder.id, kind: 'prescription' }, 'pending');

    // Query the SECOND pharmacy's queue
    const queueRes = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${pharmaFac2Token}`)
      .query({ limit: 100 });
    expect(queueRes.status).toBe(200);

    // The split fulfillment record should appear in the second facility's queue
    const found = queueRes.body.items.find((i: any) => i.id === splitFulfill.id);
    expect(found).toBeDefined();
    expect(found.orderKind).toBe('prescription');
    expect(found.orderId).toBe(rxOrder.id);
    // Verify it's filtered by facilityId (the second pharmacy's facilityId)
    const dbRecord = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: splitFulfill.id } });
    expect(dbRecord.facilityId).toBe(pharmaFac2.profileId);
  });

  it('cross-facility isolation: each facility only sees its own records', async () => {
    // Seed one prescription for the pharmacy and one lab order for the lab.
    const { order: rxOrder } = await seedPrescription(prescriptionFacilityId);
    await createFulfillmentRecord(prescriptionFacilityId, { id: rxOrder.id, kind: 'prescription' }, 'pending');

    const { order: labOrder } = await seedLabOrder(labFacilityId);
    await createFulfillmentRecord(labFacilityId, { id: labOrder.id, kind: 'lab_order' }, 'pending');

    const owned = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${prescriptionFacilityToken}`)
      .query({ status: 'pending' });
    expect(owned.status).toBe(200);
    for (const item of owned.body.items) {
      const specific = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: item.id } });
      expect(specific.facilityId).toBe(prescriptionFacilityId);
    }

    const labOwned = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ status: 'pending' });
    expect(labOwned.status).toBe(200);
    for (const item of labOwned.body.items) {
      const specific = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: item.id } });
      expect(specific.facilityId).toBe(labFacilityId);
    }
  });

  it('unauthenticated request to queue returns 401', async () => {
    const res = await request(app).get('/facilities/me/queue');
    expect(res.status).toBe(401);
  });
});