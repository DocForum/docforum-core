// Integration tests for issue #73 — item-level (partial) fulfillment of
// multi-item prescriptions.
//
// What's proven here against a real Postgres (embedded, self-contained —
// same harness as booking.test.mts, own port 5438):
//  - Split routing: one drug out of stock → patient routes the remaining
//    items to a second facility, and the order-level status derives all
//    the way to `fulfilled` (partially_fulfilled in between).
//  - Double-dispense rejection: two facilities race to dispense the SAME
//    order item — exactly one wins, the loser gets 409. This is a DB
//    unique-index guarantee ((orderType, dispensedKey)), not app timing,
//    hence the genuinely concurrent test.
//  - Hard rule 5: a facility can only write its own records.
//  - Order status is forward-only: an expired order is never resurrected.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5438;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-fulfillment-pg-'));
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

/** Routing an order is a verified-email mutation (Phase 8, issue #34), so
 * the patient goes through the real signup → verify flow. Facilities are
 * created directly in the DB (admin-invite signup is issue #14's scope)
 * and minted real access tokens via the auth module's own signer. */
async function signupVerifiedPatient(): Promise<string> {
  const email = `patient-${runId}@example.com`;
  const res = await request(app).post('/auth/signup').send({
    role: 'patient',
    email,
    password: 'longenough123',
    fullName: 'Partial Fulfillment Patient',
  });
  expect(res.status).toBe(200);
  const token = emailedTokens.get(email);
  expect(token, `no verification email captured for ${email}`).toBeTruthy();
  const verified = await request(app).post('/auth/verify-email').send({ token });
  expect(verified.status).toBe(200);
  return res.body.accessToken as string;
}

async function createFacility(name: string, type: 'pharmacy' | 'lab') {
  const user = await prisma.user.create({
    data: {
      email: `${type}-${name}-${runId}@example.com`,
      passwordHash: 'not-used-in-this-test',
      role: 'facility',
      emailVerifiedAt: new Date(),
    },
  });
  const profile = await prisma.facilityProfile.create({
    data: { userId: user.id, name, type },
  });
  const token = signAccessToken({ sub: user.id, role: 'facility' });
  return { profile, token };
}

async function createPrescriptionWithItems(drugNames: string[]) {
  return prisma.prescription.create({
    data: {
      items: {
        create: drugNames.map((drugName) => ({
          drugName,
          dosage: '1 tablet',
          frequency: 'twice daily',
          duration: '5 days',
        })),
      },
    },
    include: { items: true },
  });
}

let app: App;
let prisma: Prisma;
let signAccessToken: (payload: { sub: string; role: 'patient' | 'doctor' | 'facility' | 'admin' }) => string;
let patientToken: string;
let facilityA: Awaited<ReturnType<typeof createFacility>>;
let facilityB: Awaited<ReturnType<typeof createFacility>>;

/** The PATCH route addresses the FulfillmentItem ROW under a record
 * (not the order item) — resolve it from (record, order item). */
async function itemRowId(recordId: string, orderItemId: string): Promise<string> {
  const row = await prisma.fulfillmentItem.findFirstOrThrow({
    where: { fulfillmentRecordId: recordId, orderItemId },
  });
  return row.id;
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

  // Point the app's PrismaClient (constructed at module load) at THIS
  // throwaway cluster — vitest.config's default DATABASE_URL points at
  // booking's port 5433.
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

  patientToken = await signupVerifiedPatient();
  facilityA = await createFacility('Facility A', 'pharmacy');
  facilityB = await createFacility('Facility B', 'pharmacy');
}, 120_000);

afterAll(async () => {
  await pg.stop();
});

describe('partial fulfillment (issue #73)', () => {
  it('splits a partially dispensed prescription across two facilities and derives order status', async () => {
    const prescription = await createPrescriptionWithItems([
      'Amoxicillin 500mg',
      'Ibuprofen 400mg',
      'Cetirizine 10mg',
    ]);
    // Lookup by name — PrescriptionItem has no created_at to order by.
    const itemFor = (drugName: string) => {
      const item = prescription.items.find((candidate) => candidate.drugName === drugName);
      expect(item, drugName).toBeTruthy();
      return item!;
    };
    const item1 = itemFor('Amoxicillin 500mg');
    const item2 = itemFor('Ibuprofen 400mg');
    const item3 = itemFor('Cetirizine 10mg');

    // Patient routes all three items to facility A.
    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: prescription.id, facilityId: facilityA.profile.id });
    expect(routed.status).toBe(201);
    expect(routed.body.items).toHaveLength(3);
    expect(routed.body.status).toBe('pending');
    const recordA = routed.body.id as string;

    // A dispenses item1, is out of stock on item2 + item3.
    const row1 = await itemRowId(recordA, item1.id);
    const row2 = await itemRowId(recordA, item2.id);
    const row3 = await itemRowId(recordA, item3.id);
    const dispensed = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordA}/items/${row1}`)
      .set('Authorization', `Bearer ${facilityA.token}`)
      .send({ status: 'dispensed', quantityDispensed: 1 });
    expect(dispensed.status).toBe(200);
    expect(dispensed.body.record.status).toBe('in_progress');
    expect(dispensed.body.orderStatus).toBe('partially_fulfilled');

    const outOfStock1 = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordA}/items/${row2}`)
      .set('Authorization', `Bearer ${facilityA.token}`)
      .send({ status: 'unfulfilled' });
    expect(outOfStock1.status).toBe(200);
    const outOfStock2 = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordA}/items/${row3}`)
      .set('Authorization', `Bearer ${facilityA.token}`)
      .send({ status: 'unfulfilled' });
    expect(outOfStock2.status).toBe(200);
    // Every item terminal, only one dispensed → record derives
    // partially_fulfilled (not a lie of "fulfilled", not a refusal).
    expect(outOfStock2.body.record.status).toBe('partially_fulfilled');

    const partially = await prisma.prescription.findUnique({ where: { id: prescription.id } });
    expect(partially?.status).toBe('partially_fulfilled');

    // One-shot: A can't re-mark a terminal item.
    const replay = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordA}/items/${row1}`)
      .set('Authorization', `Bearer ${facilityA.token}`)
      .send({ status: 'unfulfilled' });
    expect(replay.status).toBe(409);

    // Patient routes the two remaining items to facility B.
    const routedB = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({
        orderType: 'prescription',
        orderId: prescription.id,
        facilityId: facilityB.profile.id,
        orderItemIds: [item2.id, item3.id],
      });
    expect(routedB.status).toBe(201);
    expect(routedB.body.items).toHaveLength(2);
    const recordB = routedB.body.id as string;

    // The already-dispensed item can never be routed again.
    const reroute = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({
        orderType: 'prescription',
        orderId: prescription.id,
        facilityId: facilityB.profile.id,
        orderItemIds: [item1.id],
      });
    expect(reroute.status).toBe(409);

    // B dispenses both remaining items → order finally derives fulfilled.
    const rowB2 = await itemRowId(recordB, item2.id);
    const rowB3 = await itemRowId(recordB, item3.id);
    const dispense2 = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordB}/items/${rowB2}`)
      .set('Authorization', `Bearer ${facilityB.token}`)
      .send({ status: 'dispensed', quantityDispensed: 1 });
    expect(dispense2.status).toBe(200);
    expect(dispense2.body.orderStatus).toBe('partially_fulfilled');

    const dispense3 = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${recordB}/items/${rowB3}`)
      .set('Authorization', `Bearer ${facilityB.token}`)
      .send({ status: 'dispensed', quantityDispensed: 1 });
    expect(dispense3.status).toBe(200);
    expect(dispense3.body.orderStatus).toBe('fulfilled');
    expect(dispense3.body.record.status).toBe('fulfilled');

    const done = await prisma.prescription.findUnique({ where: { id: prescription.id } });
    expect(done?.status).toBe('fulfilled');

    const summary = await request(app)
      .get(`/pharmacy-orders/orders/${prescription.id}/fulfillment-status?orderType=prescription`)
      .set('Authorization', `Bearer ${patientToken}`);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ totalItems: 3, dispensedItems: 3, status: 'fulfilled' });
  });

  it('rejects a second facility dispensing the same item — including under concurrency', async () => {
    const prescription = await createPrescriptionWithItems(['Metformin 500mg']);
    const [item] = prescription.items;

    // Both facilities hold a routed row for the same item (patient
    // shopped around) — legal while nothing is dispensed.
    const routeA = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: prescription.id, facilityId: facilityA.profile.id });
    expect(routeA.status).toBe(201);
    const routeB = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({
        orderType: 'prescription',
        orderId: prescription.id,
        facilityId: facilityB.profile.id,
        orderItemIds: [item.id],
      });
    expect(routeB.status).toBe(201);

    // Genuinely concurrent dispense attempts on the same order item.
    const raceRowA = await itemRowId(routeA.body.id, item.id);
    const raceRowB = await itemRowId(routeB.body.id, item.id);
    const [a, b] = await Promise.all([
      request(app)
        .patch(`/pharmacy-orders/fulfillments/${routeA.body.id}/items/${raceRowA}`)
        .set('Authorization', `Bearer ${facilityA.token}`)
        .send({ status: 'dispensed', quantityDispensed: 1 }),
      request(app)
        .patch(`/pharmacy-orders/fulfillments/${routeB.body.id}/items/${raceRowB}`)
        .set('Authorization', `Bearer ${facilityB.token}`)
        .send({ status: 'dispensed', quantityDispensed: 1 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const dispensedRows = await prisma.fulfillmentItem.findMany({
      where: { orderType: 'prescription', orderItemId: item.id, status: 'dispensed' },
    });
    expect(dispensedRows).toHaveLength(1);

    // The loser's row must be untouched (its transaction rolled back),
    // and a retry must also 409.
    const loser = a.status === 409 ? a : b;
    expect(loser.body.message).toMatch(/already been dispensed/i);
    const retry = await request(app)
      .patch(
        `/pharmacy-orders/fulfillments/${a.status === 409 ? routeA.body.id : routeB.body.id}/items/${
          a.status === 409 ? raceRowA : raceRowB
        }`,
      )
      .set('Authorization', `Bearer ${a.status === 409 ? facilityA.token : facilityB.token}`)
      .send({ status: 'dispensed', quantityDispensed: 1 });
    expect(retry.status).toBe(409);
  });

  it("enforces hard rule 5: a facility can only write its own record's items", async () => {
    const prescription = await createPrescriptionWithItems(['Losartan 50mg']);
    const [item] = prescription.items;
    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: prescription.id, facilityId: facilityA.profile.id });
    expect(routed.status).toBe(201);
    const rule5Row = await itemRowId(routed.body.id, item.id);

    // Facility B writing to facility A's record → 403, item untouched.
    const crossWrite = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${routed.body.id}/items/${rule5Row}`)
      .set('Authorization', `Bearer ${facilityB.token}`)
      .send({ status: 'dispensed', quantityDispensed: 1 });
    expect(crossWrite.status).toBe(403);

    // And B can't read A's record either.
    const crossRead = await request(app)
      .get(`/pharmacy-orders/fulfillments/${routed.body.id}`)
      .set('Authorization', `Bearer ${facilityB.token}`);
    expect(crossRead.status).toBe(403);

    // `fulfilled` is derived, never settable on the record.
    const forceFulfilled = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${routed.body.id}`)
      .set('Authorization', `Bearer ${facilityA.token}`)
      .send({ status: 'fulfilled' });
    expect(forceFulfilled.status).toBe(400);

    // Patients can't dispense (route-level role gate).
    const patientDispense = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${routed.body.id}/items/${rule5Row}`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ status: 'dispensed', quantityDispensed: 1 });
    expect(patientDispense.status).toBe(403);

    const untouched = await prisma.fulfillmentItem.findFirst({
      where: { fulfillmentRecordId: routed.body.id, orderItemId: item.id },
    });
    expect(untouched?.status).toBe('pending');
  });

  it('never resurrects an expired order when a dispense lands (forward-only status)', async () => {
    const prescription = await createPrescriptionWithItems(['Omeprazole 20mg']);
    const [item] = prescription.items;
    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: prescription.id, facilityId: facilityA.profile.id });
    expect(routed.status).toBe(201);

    await prisma.prescription.update({
      where: { id: prescription.id },
      data: { status: 'expired' },
    });

    const expiredRow = await itemRowId(routed.body.id, item.id);
    const dispense = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${routed.body.id}/items/${expiredRow}`)
      .set('Authorization', `Bearer ${facilityA.token}`)
      .send({ status: 'dispensed', quantityDispensed: 1 });
    expect(dispense.status).toBe(200);

    const after = await prisma.prescription.findUnique({ where: { id: prescription.id } });
    expect(after?.status).toBe('expired');
  });

  it('fulfills a lab order (single-item order) through the same item path', async () => {
    const user = await prisma.user.findUnique({ where: { email: `patient-${runId}@example.com` } });
    const labOrder = await prisma.labOrder.create({
      data: { testType: 'malaria rapid test', urgency: 'routine' },
    });
    void user;

    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'lab_order', orderId: labOrder.id, facilityId: facilityA.profile.id });
    expect(routed.status).toBe(201);
    expect(routed.body.items).toHaveLength(1);

    const labRow = await itemRowId(routed.body.id, labOrder.id);
    const dispense = await request(app)
      .patch(`/pharmacy-orders/fulfillments/${routed.body.id}/items/${labRow}`)
      .set('Authorization', `Bearer ${facilityA.token}`)
      .send({ status: 'dispensed', quantityDispensed: 1 });
    expect(dispense.status).toBe(200);
    expect(dispense.body.orderStatus).toBe('fulfilled');

    const after = await prisma.labOrder.findUnique({ where: { id: labOrder.id } });
    expect(after?.status).toBe('fulfilled');
  });

  it('rejects routing items that do not belong to the order', async () => {
    const prescription = await createPrescriptionWithItems(['Vitamin C 1000mg']);
    const stranger = await createPrescriptionWithItems(['Stranger Item']);
    const res = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({
        orderType: 'prescription',
        orderId: prescription.id,
        facilityId: facilityA.profile.id,
        orderItemIds: [stranger.items[0].id],
      });
    expect(res.status).toBe(400);
  });
});
