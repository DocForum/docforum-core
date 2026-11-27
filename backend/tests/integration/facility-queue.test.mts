// Integration tests for issue #15 — facility fulfillment queue and status
// transitions, including the access-control invariant that `fulfilled` is
// NEVER directly settable: it is derived from dispensed items only.
// Also covers the issue #11 patient view, GET /orders/mine (current orders
// only; superseded prescriptions are hidden).
//
// What's proven here against a real Postgres (embedded, self-contained,
// own port 5460):
//
//  - GET /pharmacy-orders/facility/queue returns ONLY the caller's own
//    FulfillmentRecords, nothing from another facility.
//  - PATCH /pharmacy-orders/fulfillments/:id with { status: 'fulfilled' }
//    is rejected 400 (validation layer: z.enum(['in_progress', 'rejected'])).
//  - A different facility attempting to PATCH a record it does not own
//    receives 403, never 200.
//  - A patient attempting to dispense (the only path to `fulfilled`) via
//    PATCH /pharmacy-orders/fulfillments/:id/items/:itemId receives 403.
//  - Only the assigned facility can transition a record all the way to
//    `fulfilled`, and only via item-level dispense writes.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5460;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-facility-queue-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_facility_queue_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

let app: App;
let prisma: Prisma;
let signAccessToken: (payload: { sub: string; role: 'patient' | 'doctor' | 'facility' | 'admin' }) => string;
let patientToken: string;
let patientProfileId: string;
let facilityAToken: string;
let facilityAId: string;
let facilityBToken: string;
let facilityBId: string;
let contextSeq = 0;

async function createFacility(name: string) {
  const user = await prisma.user.create({
    data: {
      email: `facility-${name}-${runId}@example.com`,
      passwordHash: 'unused-in-test',
      role: 'facility',
      emailVerifiedAt: new Date(),
    },
  });
  const profile = await prisma.facilityProfile.create({
    data: { userId: user.id, name, type: 'pharmacy' },
  });
  await prisma.facilityCapability.create({
    data: { facilityProfileId: profile.id, capabilityType: 'medication_dispense' },
  });
  const token = signAccessToken({ sub: user.id, role: 'facility' });
  return { profile, token };
}

async function createOrderContext(): Promise<{ consultationId: string; doctorProfileId: string }> {
  contextSeq += 1;
  const user = await prisma.user.create({
    data: {
      email: `fq-doctor-${contextSeq}-${runId}@example.com`,
      passwordHash: 'unused',
      role: 'doctor',
    },
  });
  const doctor = await prisma.doctorProfile.create({
    data: { userId: user.id, fullName: 'Queue Test Doctor', timeZone: 'UTC', verificationStatus: 'verified' },
  });
  const startTime = new Date(Date.now() + contextSeq * 60 * 60 * 1000);
  const slot = await prisma.availabilitySlot.create({
    data: { doctorProfileId: doctor.id, startTime, endTime: new Date(startTime.getTime() + 30 * 60 * 1000) },
  });
  const appointment = await prisma.appointment.create({
    data: { patientProfileId, doctorProfileId: doctor.id, availabilitySlotId: slot.id },
  });
  const consultation = await prisma.consultation.create({ data: { appointmentId: appointment.id } });
  return { consultationId: consultation.id, doctorProfileId: doctor.id };
}

async function createPrescription(facilityId: string) {
  const ctx = await createOrderContext();
  return prisma.prescription.create({
    data: {
      consultationId: ctx.consultationId,
      patientProfileId,
      prescribingDoctorId: ctx.doctorProfileId,
      facilityProfileId: facilityId,
      amountStroops: 1_000n,
      items: { create: [{ drugName: 'Amoxicillin 500mg', dosage: '1 tab', frequency: 'daily', duration: '5d' }] },
    },
    include: { items: true },
  });
}

/** Returns the FulfillmentItem row id for a given order item under a record. */
async function itemRowId(recordId: string, orderItemId: string): Promise<string> {
  const row = await prisma.fulfillmentItem.findFirstOrThrow({
    where: { fulfillmentRecordId: recordId, orderItemId },
  });
  return row.id;
}

beforeAll(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('docforum_facility_queue_test');

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;

  const appModule = await import('../../src/app.js');
  const dbModule = await import('../../src/db/prisma-client.js');
  const tokensModule = await import('../../src/modules/auth/services/tokens.js');
  app = appModule.createApp();
  prisma = dbModule.prisma;
  signAccessToken = tokensModule.signAccessToken;

  // Patient
  const patientUser = await prisma.user.create({
    data: {
      email: `fq-patient-${runId}@example.com`,
      passwordHash: 'unused',
      role: 'patient',
      emailVerifiedAt: new Date(),
    },
  });
  const patientProfile = await prisma.patientProfile.create({
    data: { userId: patientUser.id, fullName: 'Queue Test Patient' },
  });
  patientProfileId = patientProfile.id;
  patientToken = signAccessToken({ sub: patientUser.id, role: 'patient' });

  // Facilities
  const facilityA = await createFacility('QueueFacilityA');
  facilityAToken = facilityA.token;
  facilityAId = facilityA.profile.id;

  const facilityB = await createFacility('QueueFacilityB');
  facilityBToken = facilityB.token;
  facilityBId = facilityB.profile.id;
}, 120_000);

afterAll(async () => {
  await pg.stop();
});

describe('facility fulfillment queue (issue #15)', () => {
  it('GET /pharmacy-orders/facility/queue returns only the caller facility records', async () => {
    // Route a prescription to facility A
    const rxA = await createPrescription(facilityAId);
    const routedA = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: rxA.id, facilityId: facilityAId });
    expect(routedA.status).toBe(201);
    const recordAId = routedA.body.id as string;

    // Route a prescription to facility B
    const rxB = await createPrescription(facilityBId);
    const routedB = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: rxB.id, facilityId: facilityBId });
    expect(routedB.status).toBe(201);

    // Facility A's queue contains only its own record
    const queueA = await request(app)
      .get('/pharmacy-orders/facility/queue')
      .set('Authorization', `Bearer ${facilityAToken}`);
    expect(queueA.status).toBe(200);
    const aIds = (queueA.body.records as { id: string }[]).map((r) => r.id);
    expect(aIds).toContain(recordAId);
    // Facility B's record must NOT appear in facility A's queue
    expect(aIds).not.toContain(routedB.body.id);

    // Facility B's queue contains only its own record
    const queueB = await request(app)
      .get('/pharmacy-orders/facility/queue')
      .set('Authorization', `Bearer ${facilityBToken}`);
    expect(queueB.status).toBe(200);
    const bIds = (queueB.body.records as { id: string }[]).map((r) => r.id);
    expect(bIds).toContain(routedB.body.id as string);
    expect(bIds).not.toContain(recordAId);
  });

  it('PATCH /fulfillments/:id with { status: "fulfilled" } is rejected 400 (validation)', async () => {
    const rx = await createPrescription(facilityAId);
    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: rx.id, facilityId: facilityAId });
    expect(routed.status).toBe(201);
    const recordId = routed.body.id as string;

    // `fulfilled` is not in z.enum(['in_progress', 'rejected']) — must be 400
    const res = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordId}`)
      .set('Authorization', `Bearer ${facilityAToken}`)
      .send({ status: 'fulfilled' });
    expect(res.status).toBe(400);
  });

  it('a different facility cannot PATCH a record it does not own (403)', async () => {
    const rx = await createPrescription(facilityAId);
    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: rx.id, facilityId: facilityAId });
    expect(routed.status).toBe(201);
    const recordId = routed.body.id as string;

    // Facility B tries to move Facility A's record to in_progress
    const res = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordId}`)
      .set('Authorization', `Bearer ${facilityBToken}`)
      .send({ status: 'in_progress' });
    expect(res.status).toBe(403);
  });

  it('a patient cannot dispense items (the only path to fulfilled) — 403', async () => {
    const rx = await createPrescription(facilityAId);
    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: rx.id, facilityId: facilityAId });
    expect(routed.status).toBe(201);
    const recordId = routed.body.id as string;
    const item = rx.items[0];
    expect(item).toBeTruthy();
    const rowId = await itemRowId(recordId, item.id);

    // Patient attempts to dispense — must be blocked at role check
    const res = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordId}/items/${rowId}`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ status: 'dispensed', quantityDispensed: 1 });
    expect(res.status).toBe(403);
  });

  it('only the assigned facility can dispense, reaching fulfilled via item writes', async () => {
    const rx = await createPrescription(facilityAId);
    const item = rx.items[0];
    expect(item).toBeTruthy();

    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: rx.id, facilityId: facilityAId });
    expect(routed.status).toBe(201);
    expect(routed.body.status).toBe('pending');
    const recordId = routed.body.id as string;
    const rowId = await itemRowId(recordId, item.id);

    // Assigned facility A dispenses the only item → record + order reach fulfilled
    const dispensed = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordId}/items/${rowId}`)
      .set('Authorization', `Bearer ${facilityAToken}`)
      .send({ status: 'dispensed', quantityDispensed: 1 });
    expect(dispensed.status).toBe(200);
    expect(dispensed.body.record.status).toBe('fulfilled');
    expect(dispensed.body.orderStatus).toBe('fulfilled');

    // The queue now shows the record as fulfilled
    const queue = await request(app)
      .get('/pharmacy-orders/facility/queue')
      .set('Authorization', `Bearer ${facilityAToken}`);
    expect(queue.status).toBe(200);
    const record = (queue.body.records as { id: string; status: string }[]).find((r) => r.id === recordId);
    expect(record?.status).toBe('fulfilled');
  });

  it('a non-facility role gets 403 on the queue endpoint', async () => {
    const res = await request(app)
      .get('/pharmacy-orders/facility/queue')
      .set('Authorization', `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });
});

describe('patient orders view (issue #11)', () => {
  it('GET /orders/mine returns only current prescriptions and lab orders, hiding superseded ones', async () => {
    const original = await createPrescription(facilityAId);
    const ctx = await createOrderContext();
    const correction = await prisma.prescription.create({
      data: {
        consultationId: ctx.consultationId,
        patientProfileId,
        prescribingDoctorId: ctx.doctorProfileId,
        facilityProfileId: facilityAId,
        amountStroops: 1_000n,
        supersedesPrescriptionId: original.id,
        items: { create: [{ drugName: 'Amoxicillin 250mg', dosage: '1 tab', frequency: 'daily', duration: '5d' }] },
      },
    });
    const labOrder = await prisma.labOrder.create({
      data: {
        consultationId: ctx.consultationId,
        patientProfileId,
        orderingDoctorId: ctx.doctorProfileId,
        facilityProfileId: facilityAId,
        amountStroops: 2_000n,
        testType: 'Full blood count',
      },
    });

    const res = await request(app)
      .get('/orders/mine')
      .set('Authorization', `Bearer ${patientToken}`);
    expect(res.status).toBe(200);
    const rxIds = (res.body.prescriptions as { id: string }[]).map((p) => p.id);
    expect(rxIds).toContain(correction.id);
    expect(rxIds).not.toContain(original.id);
    const labIds = (res.body.labOrders as { id: string; amountStroops: string }[]).map((l) => l.id);
    expect(labIds).toContain(labOrder.id);
    // BigInt amounts are serialized as strings.
    expect(typeof (res.body.prescriptions as { amountStroops: unknown }[])[0]?.amountStroops).toBe('string');
  });

  it('GET /orders/mine is patient-only (403 for a facility)', async () => {
    const res = await request(app)
      .get('/orders/mine')
      .set('Authorization', `Bearer ${facilityAToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /orders/mine requires authentication (401)', async () => {
    const res = await request(app).get('/orders/mine');
    expect(res.status).toBe(401);
  });
});
