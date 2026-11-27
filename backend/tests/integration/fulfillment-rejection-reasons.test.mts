// Integration tests for issue #322 — structured rejection reasons on
// FulfillmentRecord (whole-record rejection) and FulfillmentItem (unfulfilled).
//
// What is proven here:
//  - Rejecting a whole record requires a rejectionReason (400 without it).
//  - Marking an item unfulfilled requires unfulfilledReason (400 without it).
//  - Valid reason + optional note are stored atomically with the transition.
//  - getOrderFulfillmentSummary surfaces rejection/unfulfilled reasons to the
//    patient view (issue #322 §"expose to patient view").
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5500;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-rejection-reasons-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_rejection_reasons_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

let app: App;
let prisma: Prisma;
let signAccessToken: (payload: { sub: string; role: 'patient' | 'facility' | 'admin' }) => string;
let patientToken: string;
let patientProfileId: string;
let facilityToken: string;
let facilityProfileId: string;
let contextSeq = 0;

const emailedTokens = new Map<string, string>();

async function createOrderContext(): Promise<{ consultationId: string; doctorProfileId: string }> {
  contextSeq += 1;
  const user = await prisma.user.create({
    data: {
      email: `rr-doctor-${contextSeq}-${runId}@example.com`,
      passwordHash: 'unused',
      role: 'doctor',
    },
  });
  const doctor = await prisma.doctorProfile.create({
    data: { userId: user.id, fullName: 'RR Fixture Doctor', timeZone: 'UTC', verificationStatus: 'verified' },
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

async function createPrescription(drugNames: string[]) {
  const ctx = await createOrderContext();
  return prisma.prescription.create({
    data: {
      consultationId: ctx.consultationId,
      patientProfileId,
      prescribingDoctorId: ctx.doctorProfileId,
      facilityProfileId,
      amountStroops: 1_000n,
      items: {
        create: drugNames.map((drugName) => ({
          drugName,
          dosage: '1 tablet',
          frequency: 'once daily',
          duration: '7 days',
        })),
      },
    },
    include: { items: true },
  });
}

async function itemRowId(recordId: string, orderItemId: string): Promise<string> {
  const row = await prisma.fulfillmentItem.findFirstOrThrow({
    where: { fulfillmentRecordId: recordId, orderItemId },
  });
  return row.id;
}

beforeAll(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('docforum_rejection_reasons_test');

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;

  const appModule = await import('../../src/app.js');
  const dbModule = await import('../../src/db/prisma-client.js');
  const authServices = await import('../../src/modules/auth/services/index.js');
  const tokensModule = await import('../../src/modules/auth/services/tokens.js');
  app = appModule.createApp();
  prisma = dbModule.prisma;
  signAccessToken = tokensModule.signAccessToken;

  authServices.setEmailSender(async (message) => {
    const match = /[?&]token=([^&\s]+)/.exec(message.text);
    if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
  });

  // Create patient via signup+verify (verified email required for routing).
  const email = `rr-patient-${runId}@example.com`;
  const signupRes = await request(app).post('/auth/signup').send({
    role: 'patient',
    email,
    password: 'longenough123',
    fullName: 'Rejection Reason Patient',
  });
  expect(signupRes.status).toBe(200);
  patientToken = signupRes.body.accessToken;
  const verifyToken = emailedTokens.get(email);
  expect(verifyToken).toBeTruthy();
  await request(app).post('/auth/verify-email').send({ token: verifyToken });
  const patientUser = await prisma.user.findUniqueOrThrow({ where: { email } });
  const patientProfile = await prisma.patientProfile.findUniqueOrThrow({ where: { userId: patientUser.id } });
  patientProfileId = patientProfile.id;

  // Create facility directly (admin-invite flow is out of scope here).
  const facilityUser = await prisma.user.create({
    data: { email: `rr-facility-${runId}@example.com`, passwordHash: 'unused', role: 'facility', emailVerifiedAt: new Date() },
  });
  const facilityProfile = await prisma.facilityProfile.create({
    data: { userId: facilityUser.id, name: `RR Pharmacy ${runId}`, type: 'pharmacy' },
  });
  facilityProfileId = facilityProfile.id;
  facilityToken = signAccessToken({ sub: facilityUser.id, role: 'facility' });
}, 120_000);

afterAll(async () => {
  await pg.stop();
});

describe('rejection reasons — whole record (issue #322)', () => {
  it('rejects a 400 when rejecting without a rejectionReason', async () => {
    const prescription = await createPrescription(['Drug A']);
    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: prescription.id, facilityId: facilityProfileId });
    expect(routed.status).toBe(201);
    const recordId = routed.body.id as string;

    const res = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordId}`)
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ status: 'rejected' });
    expect(res.status).toBe(400);
  });

  it('stores rejectionReason and optional note atomically with the rejection', async () => {
    const prescription = await createPrescription(['Drug B']);
    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: prescription.id, facilityId: facilityProfileId });
    expect(routed.status).toBe(201);
    const recordId = routed.body.id as string;

    const res = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordId}`)
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ status: 'rejected', rejectionReason: 'facility_closure', rejectionNote: 'Closed for renovation' });
    expect(res.status).toBe(200);

    const row = await prisma.fulfillmentRecord.findUniqueOrThrow({ where: { id: recordId } });
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('facility_closure');
    expect(row.rejectionNote).toBe('Closed for renovation');
  });

  it('rejects a note longer than 500 characters', async () => {
    const prescription = await createPrescription(['Drug C']);
    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: prescription.id, facilityId: facilityProfileId });
    expect(routed.status).toBe(201);
    const recordId = routed.body.id as string;

    const res = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordId}`)
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ status: 'rejected', rejectionReason: 'other', rejectionNote: 'x'.repeat(501) });
    expect(res.status).toBe(400);
  });
});

describe('rejection reasons — per-item unfulfilled (issue #322)', () => {
  it('returns 400 when marking an item unfulfilled without unfulfilledReason', async () => {
    const prescription = await createPrescription(['Drug D', 'Drug E']);
    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: prescription.id, facilityId: facilityProfileId });
    expect(routed.status).toBe(201);
    const recordId = routed.body.id as string;
    const itemId = await itemRowId(recordId, prescription.items[0]!.id);

    const res = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordId}/items/${itemId}`)
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ status: 'unfulfilled' });
    expect(res.status).toBe(400);
  });

  it('stores unfulfilledReason and optional note atomically', async () => {
    const prescription = await createPrescription(['Drug F', 'Drug G']);
    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: prescription.id, facilityId: facilityProfileId });
    expect(routed.status).toBe(201);
    const recordId = routed.body.id as string;
    const item0Id = await itemRowId(recordId, prescription.items[0]!.id);
    const item1Id = await itemRowId(recordId, prescription.items[1]!.id);

    const res = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordId}/items/${item0Id}`)
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ status: 'unfulfilled', unfulfilledReason: 'expired_stock', unfulfilledNote: 'Batch recall' });
    expect(res.status).toBe(200);

    const row = await prisma.fulfillmentItem.findUniqueOrThrow({ where: { id: item0Id } });
    expect(row.status).toBe('unfulfilled');
    expect(row.unfulfilledReason).toBe('expired_stock');
    expect(row.unfulfilledNote).toBe('Batch recall');

    // Finish off the second item so the record reaches a terminal state.
    await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordId}/items/${item1Id}`)
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ status: 'unfulfilled', unfulfilledReason: 'out_of_stock' });
  });
});

describe('patient view includes rejection/unfulfilled reasons (issue #322)', () => {
  it('getOrderFulfillmentSummary surfaces rejection reasons', async () => {
    const prescription = await createPrescription(['Drug H']);
    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: prescription.id, facilityId: facilityProfileId });
    expect(routed.status).toBe(201);
    const recordId = routed.body.id as string;

    // Reject the whole record with a reason.
    await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordId}`)
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ status: 'rejected', rejectionReason: 'no_staff_available', rejectionNote: 'Short staffed today' });

    // Patient checks the order summary.
    const summary = await request(app)
      .get(`/pharmacy-orders/orders/${prescription.id}/fulfillment-status?orderType=prescription`)
      .set('Authorization', `Bearer ${patientToken}`);
    expect(summary.status).toBe(200);
    expect(summary.body.rejections).toHaveLength(1);
    expect(summary.body.rejections[0].reason).toBe('no_staff_available');
    expect(summary.body.rejections[0].note).toBe('Short staffed today');
  });

  it('getOrderFulfillmentSummary surfaces unfulfilled item reasons', async () => {
    const prescription = await createPrescription(['Drug I', 'Drug J']);
    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: prescription.id, facilityId: facilityProfileId });
    expect(routed.status).toBe(201);
    const recordId = routed.body.id as string;
    const item0Id = await itemRowId(recordId, prescription.items[0]!.id);
    const item1Id = await itemRowId(recordId, prescription.items[1]!.id);

    await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordId}/items/${item0Id}`)
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ status: 'dispensed', quantityDispensed: 1 });
    await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordId}/items/${item1Id}`)
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ status: 'unfulfilled', unfulfilledReason: 'item_discontinued', unfulfilledNote: 'No longer stocked' });

    const summary = await request(app)
      .get(`/pharmacy-orders/orders/${prescription.id}/fulfillment-status?orderType=prescription`)
      .set('Authorization', `Bearer ${patientToken}`);
    expect(summary.status).toBe(200);
    expect(summary.body.unfulfilledItems).toHaveLength(1);
    expect(summary.body.unfulfilledItems[0].reason).toBe('item_discontinued');
    expect(summary.body.unfulfilledItems[0].note).toBe('No longer stocked');
  });
});
