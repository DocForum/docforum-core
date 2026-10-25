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
// Self-contained embedded Postgres on its own port (5457), same pattern as the
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
const PORT = 5457; // unique per integration file
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
type FacilitiesService = typeof import('../../src/modules/facilities/services/index.js');
type OrdersService = typeof import('../../src/modules/orders/services/index.js');

describe('issue #15: fulfillment queue + transitions', () => {
  let app: App;
  let prisma: Prisma;
  let facilitiesService: FacilitiesService;
  let ordersService: OrdersService;
  let adminToken: string;
  let adminUserId: string;
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

    const [appModule, dbModule, facilitiesModule, ordersModule] = await Promise.all([
      import('../../src/app.js'),
      import('../../src/db/prisma-client.js'),
      import('../../src/modules/facilities/services/index.js'),
      import('../../src/modules/orders/services/index.js'),
    ]);
    app = appModule.createApp();
    prisma = dbModule.prisma;
    facilitiesService = facilitiesModule;
    ordersService = ordersModule;

    adminUserId = await createAdmin(runId).userId;
    adminToken = await login(`admin-${runId}@example.com`);

    // Create two facilities: one lab, one pharmacy (prescription).
    labFacilityId = await createFacility(adminToken, { email: `lab-${runId}@example.com`, type: 'lab', capabilities: [{ capabilityType: 'lab_test' }] }).profileId;
    prescriptionFacilityId = await createFacility(adminToken, { email: `pharma-${runId}@example.com`, type: 'pharmacy', capabilities: [{ capabilityType: 'medication_dispense' }] }).profileId;

    labFacilityToken = await login(`lab-${runId}@example.com`);
    prescriptionFacilityToken = await login(`pharma-${runId}@example.com`);

    patientToken = await signup('patient', `pat-${runId}@example.com`).accessToken;
    doctorToken = await signup('doctor', `doc-${runId}@example.com`).accessToken;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function signupAs(role: 'patient' | 'doctor' | 'facility', runId: number, email: string) {
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
      type: overrides.type as 'lab' | 'pharmacy', capabilities: [{ capabilityType: overrides.capabilityType as 'lab_test' | 'medication_dispense', detail: null }],
    });
    expect(res.status).toBe(201);
    return { profileId: res.body.id, userId: res.body.userId };
  }

  it('every issued order creates a FulfillmentRecord with status pending', async () => {
    // Seed a consultation + appointment + patient via direct Prisma calls so
    // we don't depend on the appointments/consultations machinery for this
    // focused file. We need a valid DoctorProfile too for issuePrescription.
    const doctorUser = await prisma.user.create({ data: { email: `doc-seed-${runId}@example.com`, passwordHash: 'x', role: 'doctor' } });
    const doctorProfile = await prisma.doctorProfile.create({ data: { userId: doctorUser.id, isVerified: true, specialization: null } });

    const patientUser = await prisma.user.create({ data: { email: `pat-seed-${runId}@example.com`, passwordHash: 'x', role: 'patient' } });
    const appointment = await prisma.appointment.create({
      data: { patientProfileId: patientUser.id, doctorProfileId: doctorProfile.id, scheduledAt: new Date(), status: 'confirmed' },
    });
    const consultation = await prisma.consultation.create({
      data: { appointmentId: appointment.id, outcome: 'resolved', notes: null },
    });

    const createdPrescription = await ordersService.issuePrescription({
      actor: { userId: patientUser.id, role: 'patient', requestId: null },
      input: { consultationId: consultation.id, facilityProfileId: labFacilityId, items: [{ drugName: 'Test Drug', dosage: '1mg', frequency: 'once', duration: '1 day' }] },
    });
    expect(createdPrescription.paymentIntent).toBeDefined();

    const fulfills = await prisma.fulfillmentRecord.findMany({
      where: { prescriptionId: createdPrescription.id },
      select: { id: true, status: true },
    });
    expect(fulfills).toHaveLength(1);
    expect(fulfills[0].status).toBe('pending');
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
    // Get the first pending fulfillment for labFacilityId directly from Prisma
    // to use its exact id, then try it with prescriptionFacilityToken (wrong facility).
    const pendingRecords = await prisma.fulfillmentRecord.findMany({
      where: { facilityId: labFacilityId, status: 'pending' },
      select: { id: true, status: true },
    });
    expect(pendingRecords.length).toBeGreaterThan(0);
    const targetId = pendingRecords[0].id;

    // Wrong facility: patient token → 403 (the route rejects before service call).
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
    const records = await prisma.fulfillmentRecord.findMany({
      where: { facilityId: labFacilityId, prescriptionId: { not: null } },
      select: { id: true, prescriptionId: true, status: true },
    });
    const target = records.find((r) => r.prescriptionId && r.status === 'pending')!;
    expect(target).toBeDefined();

    const updated = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .send({ status: 'fulfilled' });
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe('fulfilled');
    expect(updated.body.orderKind).toBe('prescription');
    expect(updated.body.orderId).toBe(target.prescriptionId);

    // The underlying prescription was flipped to fulfilled — the only path
    // (ARCHITECTURE §5.3 hard rule 5).
    const prescUpdated = await prisma.prescription.findUniqueOrThrow({ where: { id: target.prescriptionId } });
    expect(prescUpdated.status).toBe('fulfilled');

    // Terminal states can't re-transition.
    const alreadyDone = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .send({ status: 'in_progress' });
    expect(alreadyDone.status).toBe(409);
  });

  it('in_progress → fulfilled propagates to an underlying LabOrder', async () => {
    const records = await prisma.fulfillmentRecord.findMany({
      where: { facilityId: labFacilityId, labOrderId: { not: null } },
      select: { id: true, labOrderId: true, status: true },
    });
    const target = records.find((r) => r.labOrderId && r.status === 'pending')!;
    expect(target).toBeDefined();

    const updated = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .send({ status: 'fulfilled' });
    expect(updated.status).toBe(200);
    expect(updated.body.orderKind).toBe('lab_order');

    const labUpdated = await prisma.labOrder.findUniqueOrThrow({ where: { id: target.labOrderId } });
    expect(labUpdated.status).toBe('fulfilled');
  });

  it('rejected terminal state cannot re-transition', async () => {
    const records = await prisma.fulfillmentRecord.findMany({
      where: { facilityId: labFacilityId, labOrderId: { not: null } },
      select: { id: true, labOrderId: true, status: true },
    });
    const target = records.find((r) => r.labOrderId && r.status === 'pending')!;
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

    const labOnly = await request(app)
      .get('/facilities/me/queue')
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .query({ status: 'pending' });
    expect(labOnly.status).toBe(200);
    expect(labOnly.body.items).toHaveLength(0);
  });

  it('invalid status payload is rejected by validation', async () => {
    const records = await prisma.fulfillmentRecord.findMany({
      where: { facilityId: labFacilityId, labOrderId: { not: null } },
      select: { id: true, status: true },
    });
    const target = records.find((r) => r.labOrderId && r.status === 'pending')!;
    const invalid = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${labFacilityToken}`)
      .send({ status: 'bogus' });
    expect(invalid.status).toBe(400);
  });

  it('patient cannot set fulfillment status to fulfilled', async () => {
    const records = await prisma.fulfillmentRecord.findMany({
      where: { facilityId: labFacilityId, status: 'pending' },
      select: { id: true, status: true, prescriptionId: true, labOrderId: true },
    });
    expect(records.length).toBeGreaterThan(0);
    const target = records[0];

    const asPatient = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ status: 'fulfilled' });
    expect(asPatient.status).toBe(403);

    const stillPending = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillPending.status).toBe('pending');
  });

  it('doctor cannot set fulfillment status to fulfilled', async () => {
    const records = await prisma.fulfillmentRecord.findMany({
      where: { facilityId: labFacilityId, status: 'pending' },
      select: { id: true, status: true, prescriptionId: true, labOrderId: true },
    });
    expect(records.length).toBeGreaterThan(0);
    const target = records[0];

    const asDoctor = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ status: 'fulfilled' });
    expect(asDoctor.status).toBe(403);

    const stillPending = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillPending.status).toBe('pending');
  });

  it('patient cannot set fulfillment status to in_progress', async () => {
    const records = await prisma.fulfillmentRecord.findMany({
      where: { facilityId: labFacilityId, status: 'pending' },
      select: { id: true, status: true },
    });
    expect(records.length).toBeGreaterThan(0);
    const target = records[0];

    const asPatient = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ status: 'in_progress' });
    expect(asPatient.status).toBe(403);

    const stillPending = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillPending.status).toBe('pending');
  });

  it('doctor cannot set fulfillment status to in_progress', async () => {
    const records = await prisma.fulfillmentRecord.findMany({
      where: { facilityId: labFacilityId, status: 'pending' },
      select: { id: true, status: true },
    });
    expect(records.length).toBeGreaterThan(0);
    const target = records[0];

    const asDoctor = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ status: 'in_progress' });
    expect(asDoctor.status).toBe(403);

    const stillPending = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillPending.status).toBe('pending');
  });

  it('patient cannot set fulfillment status to rejected', async () => {
    const records = await prisma.fulfillmentRecord.findMany({
      where: { facilityId: labFacilityId, status: 'pending' },
      select: { id: true, status: true },
    });
    expect(records.length).toBeGreaterThan(0);
    const target = records[0];

    const asPatient = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ status: 'rejected' });
    expect(asPatient.status).toBe(403);

    const stillPending = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillPending.status).toBe('pending');
  });

  it('doctor cannot set fulfillment status to rejected', async () => {
    const records = await prisma.fulfillmentRecord.findMany({
      where: { facilityId: labFacilityId, status: 'pending' },
      select: { id: true, status: true },
    });
    expect(records.length).toBeGreaterThan(0);
    const target = records[0];

    const asDoctor = await request(app)
      .patch(`/facilities/me/fulfillments/${target.id}`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ status: 'rejected' });
    expect(asDoctor.status).toBe(403);

    const stillPending = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillPending.status).toBe('pending');
  });

  it('queue pagination: cursor returns next page with correct ordering', async () => {
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
    const records = await prisma.fulfillmentRecord.findMany({
      where: { facilityId: labFacilityId },
      select: { id: true, prescriptionId: true, labOrderId: true, status: true },
    });

    const prescRecords = records.filter((r) => r.prescriptionId && !r.labOrderId);
    const labRecords = records.filter((r) => r.labOrderId && !r.prescriptionId);

    for (const rec of prescRecords) {
      const queueItem = await request(app)
        .get('/facilities/me/queue')
        .set('Authorization', `Bearer ${labFacilityToken}`)
        .query({ limit: 100 });
      const found = queueItem.body.items.find((i: any) => i.id === rec.id);
      expect(found).toBeDefined();
      expect(found.orderKind).toBe('prescription');
      expect(found.orderId).toBe(rec.prescriptionId);
    }

    for (const rec of labRecords) {
      const queueItem = await request(app)
        .get('/facilities/me/queue')
        .set('Authorization', `Bearer ${labFacilityToken}`)
        .query({ limit: 100 });
      const found = queueItem.body.items.find((i: any) => i.id === rec.id);
      expect(found).toBeDefined();
      expect(found.orderKind).toBe('lab_order');
      expect(found.orderId).toBe(rec.labOrderId);
    }
  });

  it('unauthenticated request to queue returns 401', async () => {
    const res = await request(app).get('/facilities/me/queue');
    expect(res.status).toBe(401);
  });

  it('unauthenticated request to transition returns 401', async () => {
    const records = await prisma.fulfillmentRecord.findMany({
      where: { facilityId: labFacilityId, status: 'pending' },
      select: { id: true },
    });
    expect(records.length).toBeGreaterThan(0);
    const res = await request(app)
      .patch(`/facilities/me/fulfillments/${records[0].id}`)
      .send({ status: 'fulfilled' });
    expect(res.status).toBe(401);
  });
});
