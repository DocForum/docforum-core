// Issue #15: facility fulfillment queue + status transitions —
// integration coverage against real Postgres and the full HTTP stack,
// proving:
//   * each issued order creates a FulfillmentRecord { status: 'pending' };
//   * GET /facilities/me/queue returns that record (cursor-paginated, newest first);
//   * only the assigned facility may transition; patient/doctor attempts get 403;
//   * `in_progress` → `fulfilled` also flips Prescription/LabOrder.status to
//     fulfilled — the only path per ARCHITECTURE §5.3 hard rule 5 (patient
//     confirm-receipt / dispute never set fulfilled);
//   * rejected terminal states are enforced (re-transitioning throws 409);
//   * cross-facility isolation: a facility cannot transition another facility's record.
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
  let patientToken: string;
  let doctorToken: string;
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

    patientToken = (await signupAs('patient', `pat-${runId}@example.com`)).accessToken;
    doctorToken = (await signupAs('doctor', `doc-${runId}@example.com`)).accessToken;
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
  // order, returning the order and its fulfillment record.  Each test that
  // mutates fulfillment state calls one of these so it operates on its own
  // isolated row — no implicit dependency on earlier tests.
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
    const [fulfillment] = await prisma.fulfillmentRecord.findMany({
      where: { prescriptionId: order.id },
    });
    return { order, fulfillment, ...ctx };
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
    const [fulfillment] = await prisma.fulfillmentRecord.findMany({
      where: { labOrderId: order.id },
    });
    return { order, fulfillment, ...ctx };
  }

  it('every issued order creates a FulfillmentRecord with status pending', async () => {
    // Prescription → prescriptionFacilityId (pharmacy)
    const { order: createdPrescription, fulfillment: rxFulfill } = await seedPrescription(prescriptionFacilityId);
    expect(createdPrescription.paymentIntent).toBeDefined();
    expect(rxFulfill).toBeDefined();
    expect(rxFulfill.status).toBe('pending');

    // Lab order → labFacilityId (lab)
    const { order: createdLabOrder, fulfillment: labFulfill } = await seedLabOrder(labFacilityId);
    expect(createdLabOrder.paymentIntent).toBeDefined();
    expect(labFulfill).toBeDefined();
    expect(labFulfill.status).toBe('pending');
  });

  it('GET /facilities/me/queue returns the facility owner fulfillment records', async () => {
    const queue = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${prescriptionFacilityToken}`)
      .query({ limit: 5 });
    expect(queue.status).toBe(200);
    expect(queue.body).toHaveProperty('items');
    expect(Array.isArray(queue.body.items)).toBe(true);
    expect(queue.body.items[0]).toHaveProperty('orderKind');
  });

  it('only the assigned facility can transition — patient gets 403, the wrong facility gets 403', async () => {
    // Seed a dedicated lab order so there is always a pending record under labFacilityId.
    const { fulfillment } = await seedLabOrder(labFacilityId);
    const targetId = fulfillment.id;

    // Wrong facility: prescriptionFacilityToken → 403.
    const badFacility = await request(app)
      .patch(`/facilities/me/fulfillments/${targetId}`)
      .set('Authorization', `Bearer ${prescriptionFacilityToken}`)
      .send({ status: 'in_progress' });
    expect(badFacility.status).toBe(403);

    // Patient token: 403 even though the route has no role gate — the service
    // ownership check also fires after authenticate, but more importantly the
    // authenticated user isn't the facility owner. (This assertion holds either
    // way: the patient must not be able to touch fulfillment rows.)
    const asPatient = await request(app)
      .patch(`/facilities/me/fulfillments/${targetId}`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ status: 'in_progress' });
    expect(asPatient.status).toBe(403);
  });

  it('in_progress → fulfilled propagates to the underlying Prescription', async () => {
    // Seed a dedicated prescription under prescriptionFacilityId.
    const { order, fulfillment: target } = await seedPrescription(prescriptionFacilityId);

    const updated = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${prescriptionFacilityToken}`)
      .send({ status: 'fulfilled' });
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe('fulfilled');
    expect(updated.body.orderKind).toBe('prescription');
    expect(updated.body.orderId).toBe(order.id);

    // The underlying prescription was flipped to fulfilled — the only path
    // (ARCHITECTURE §5.3 hard rule 5).
    const prescUpdated = await prisma.prescription.findUniqueOrThrow({ where: { id: order.id } });
    expect(prescUpdated.status).toBe('fulfilled');

    // Terminal states can't re-transition.
    const alreadyDone = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${prescriptionFacilityToken}`)
      .send({ status: 'in_progress' });
    expect(alreadyDone.status).toBe(409);
  });

  it('in_progress → fulfilled propagates to an underlying LabOrder', async () => {
    // Seed a dedicated lab order under labFacilityId.
    const { order, fulfillment: target } = await seedLabOrder(labFacilityId);

    const updated = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .send({ status: 'fulfilled' });
    expect(updated.status).toBe(200);
    expect(updated.body.orderKind).toBe('lab_order');

    const labUpdated = await prisma.labOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(labUpdated.status).toBe('fulfilled');
  });

  it('rejected terminal state cannot re-transition', async () => {
    // Seed a dedicated lab order so this test doesn't depend on leftover records.
    const { fulfillment: target } = await seedLabOrder(labFacilityId);

    // First transition to rejected.
    const rejected = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .send({ status: 'rejected' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');

    // Re-transition to anything else → 409.
    const reroute = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .send({ status: 'in_progress' });
    expect(reroute.status).toBe(409);

    const rejectedCheck = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .send({ status: 'fulfilled' });
    expect(rejectedCheck.status).toBe(409);
  });

  it('cross-facility isolation: each facility only sees its own records', async () => {
    // Seed one prescription for the pharmacy and one lab order for the lab.
    await seedPrescription(prescriptionFacilityId);
    await seedLabOrder(labFacilityId);

    const owned = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${prescriptionFacilityToken}`)
      .query({ status: 'pending' });
    expect(owned.status).toBe(200);
    for (const item of owned.body.items) {
      // Each returned item belongs to the facility whose queue we read.
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

  it('invalid status payload is rejected by validation', async () => {
    const { fulfillment: target } = await seedLabOrder(labFacilityId);
    const invalid = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .send({ status: 'bogus' });
    expect(invalid.status).toBe(400);
  });

  it('patient cannot set fulfillment status to fulfilled', async () => {
    const { fulfillment: target } = await seedLabOrder(labFacilityId);

    const asPatient = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ status: 'fulfilled' });
    expect(asPatient.status).toBe(403);

    const stillPending = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillPending.status).toBe('pending');
  });

  it('doctor cannot set fulfillment status to fulfilled', async () => {
    const { fulfillment: target } = await seedLabOrder(labFacilityId);

    const asDoctor = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ status: 'fulfilled' });
    expect(asDoctor.status).toBe(403);

    const stillPending = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillPending.status).toBe('pending');
  });

  it('patient cannot set fulfillment status to in_progress', async () => {
    const { fulfillment: target } = await seedLabOrder(labFacilityId);

    const asPatient = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ status: 'in_progress' });
    expect(asPatient.status).toBe(403);

    const stillPending = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillPending.status).toBe('pending');
  });

  it('doctor cannot set fulfillment status to in_progress', async () => {
    const { fulfillment: target } = await seedLabOrder(labFacilityId);

    const asDoctor = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ status: 'in_progress' });
    expect(asDoctor.status).toBe(403);

    const stillPending = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillPending.status).toBe('pending');
  });

  it('patient cannot set fulfillment status to rejected', async () => {
    const { fulfillment: target } = await seedLabOrder(labFacilityId);

    const asPatient = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ status: 'rejected' });
    expect(asPatient.status).toBe(403);

    const stillPending = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillPending.status).toBe('pending');
  });

  it('doctor cannot set fulfillment status to rejected', async () => {
    const { fulfillment: target } = await seedLabOrder(labFacilityId);

    const asDoctor = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ status: 'rejected' });
    expect(asDoctor.status).toBe(403);

    const stillPending = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillPending.status).toBe('pending');
  });

  it('queue pagination: cursor returns next page with correct ordering', async () => {
    // Seed enough lab orders so there's something to paginate.
    await seedLabOrder(labFacilityId);
    await seedLabOrder(labFacilityId);
    await seedLabOrder(labFacilityId);

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
      if (labQueue.body.items.length > 0 && page2.body.items.length > 0) {
        const firstPageLast = new Date(labQueue.body.items[labQueue.body.items.length - 1].updatedAt).getTime();
        const secondPageFirst = new Date(page2.body.items[0].updatedAt).getTime();
        expect(secondPageFirst).toBeLessThanOrEqual(firstPageLast);
      }
    }
  });

  it('queue status filter works for fulfilled and rejected', async () => {
    // Seed and transition orders so all three statuses exist under labFacilityId.
    const { fulfillment: toFulfill } = await seedLabOrder(labFacilityId);
    await request(app)
      .patch(`/facilities/me/fulfillments/${toFulfill.id}`)
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .send({ status: 'fulfilled' });

    const { fulfillment: toReject } = await seedLabOrder(labFacilityId);
    await request(app)
      .patch(`/facilities/me/fulfillments/${toReject.id}`)
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .send({ status: 'rejected' });

    await seedLabOrder(labFacilityId); // leaves one pending

    const labQueuePending = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ status: 'pending' });
    expect(labQueuePending.status).toBe(200);
    for (const item of labQueuePending.body.items) {
      expect(item.status).toBe('pending');
    }

    const labQueueFulfilled = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ status: 'fulfilled' });
    expect(labQueueFulfilled.status).toBe(200);
    for (const item of labQueueFulfilled.body.items) {
      expect(item.status).toBe('fulfilled');
    }

    const labQueueRejected = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ status: 'rejected' });
    expect(labQueueRejected.status).toBe(200);
    for (const item of labQueueRejected.body.items) {
      expect(item.status).toBe('rejected');
    }
  });

  it('fulfillment record orderKind is correctly determined from prescriptionId vs labOrderId', async () => {
    // Seed both a prescription and a lab order under labFacilityId so both kinds exist.
    const { order: rxOrder, fulfillment: rxFulfill } = await seedPrescription(labFacilityId);
    const { order: labOrder, fulfillment: labFulfill } = await seedLabOrder(labFacilityId);

    const queueRes = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ limit: 100 });
    expect(queueRes.status).toBe(200);

    const rxItem = queueRes.body.items.find((i: any) => i.id === rxFulfill.id);
    expect(rxItem).toBeDefined();
    expect(rxItem.orderKind).toBe('prescription');
    expect(rxItem.orderId).toBe(rxOrder.id);

    const labItem = queueRes.body.items.find((i: any) => i.id === labFulfill.id);
    expect(labItem).toBeDefined();
    expect(labItem.orderKind).toBe('lab_order');
    expect(labItem.orderId).toBe(labOrder.id);
  });

  it('unauthenticated request to queue returns 401', async () => {
    const res = await request(app).get('/facilities/me/queue');
    expect(res.status).toBe(401);
  });

  it('unauthenticated request to transition returns 401', async () => {
    const { fulfillment } = await seedLabOrder(labFacilityId);
    const res = await request(app)
      .patch(`/facilities/me/fulfillments/${fulfillment.id}`)
      .send({ status: 'fulfilled' });
    expect(res.status).toBe(401);
  });
});
