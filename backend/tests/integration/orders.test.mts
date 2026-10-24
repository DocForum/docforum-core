import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5457;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-orders-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_orders_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

describe('Orders integration tests', () => {
  let app: App;
  let prisma: Prisma;
  let expireUnconfirmedOrders: typeof import('../../src/jobs/order-expiry.js').expireUnconfirmedOrders;

  let patient1Token: string;
  let patient1ProfileId: string;
  let patient2Token: string;
  let facility1Token: string;
  let adminToken: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_orders_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const expiryModule = await import('../../src/jobs/order-expiry.js');

    app = appModule.createApp();
    prisma = dbModule.prisma;
    expireUnconfirmedOrders = expiryModule.expireUnconfirmedOrders;

    // Seed actors
    // Patient 1
    const p1Res = await request(app).post('/auth/signup').send({
      role: 'patient',
      email: `patient1-${runId}@example.com`,
      password: 'longenough123',
      fullName: 'Patient One',
    });
    expect(p1Res.status).toBe(200);
    patient1Token = p1Res.body.accessToken;

    const p1Profile = await prisma.patientProfile.findUniqueOrThrow({
      where: { userId: p1Res.body.user.id },
    });
    patient1ProfileId = p1Profile.id;

    // Patient 2
    const p2Res = await request(app).post('/auth/signup').send({
      role: 'patient',
      email: `patient2-${runId}@example.com`,
      password: 'longenough123',
      fullName: 'Patient Two',
    });
    expect(p2Res.status).toBe(200);
    patient2Token = p2Res.body.accessToken;

    // Facility & Admin via direct DB insert
    const bcryptjs = await import('bcryptjs');
    const hash = await bcryptjs.hash('longenough123', 4);

    const facilityUser = await prisma.user.create({
      data: {
        email: `facility1-${runId}@example.com`,
        passwordHash: hash,
        role: 'facility',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.facilityProfile.create({
      data: {
        userId: facilityUser.id,
        name: `Pharmacy ${runId}`,
        type: 'pharmacy',
      },
    });

    const facLogin = await request(app).post('/auth/login').send({
      email: `facility1-${runId}@example.com`,
      password: 'longenough123',
    });
    expect(facLogin.status).toBe(200);
    facility1Token = facLogin.body.accessToken;

    await prisma.user.create({
      data: {
        email: `admin1-${runId}@example.com`,
        passwordHash: hash,
        role: 'admin',
        emailVerifiedAt: new Date(),
      },
    });
    const adminLogin = await request(app).post('/auth/login').send({
      email: `admin1-${runId}@example.com`,
      password: 'longenough123',
    });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('facility fulfills pharmacy order with proof (reference number required)', async () => {
    // 1. Create pharmacy order
    const orderRes = await request(app)
      .post('/pharmacy-orders')
      .set('Authorization', `Bearer ${patient1Token}`)
      .send({ patientProfileId: patient1ProfileId, details: 'Amoxicillin 500mg' });

    expect(orderRes.status).toBe(201);
    const orderId = orderRes.body.id;
    expect(orderRes.body.status).toBe('issued');
    expect(orderRes.body.confirmedSignal).toBe(false);

    // 2. Patient cannot fulfill order (facility-only)
    const patientFulfill = await request(app)
      .post(`/pharmacy-orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${patient1Token}`)
      .send({ referenceNumber: 'REF-12345' });
    expect(patientFulfill.status).toBe(403);

    // 3. Facility fulfills without reference number -> 400 Bad Request
    const missingRef = await request(app)
      .post(`/pharmacy-orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${facility1Token}`)
      .send({ referenceNumber: '' });
    expect(missingRef.status).toBe(400);

    // 4. Facility fulfills with reference number & optional attachment -> 200
    const fulfillRes = await request(app)
      .post(`/pharmacy-orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${facility1Token}`)
      .send({
        referenceNumber: 'REF-PHARM-99',
        attachment: { fileName: 'receipt.pdf' },
        notes: 'Dispensed 30 capsules',
      });

    expect(fulfillRes.status).toBe(200);
    expect(fulfillRes.body.status).toBe('fulfilled');
    expect(fulfillRes.body.fulfillmentProofs).toHaveLength(1);
    expect(fulfillRes.body.fulfillmentProofs[0].referenceNumber).toBe('REF-PHARM-99');
    expect(fulfillRes.body.fulfillmentProofs[0].attachmentUrl).toMatch(/^storage:\/\/attachments\/\d+-receipt\.pdf$/);

    // 5. Trying to fulfill again -> 409 Conflict
    const secondFulfill = await request(app)
      .post(`/pharmacy-orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${facility1Token}`)
      .send({ referenceNumber: 'REF-DUP' });
    expect(secondFulfill.status).toBe(409);
  });

  it('patient confirm-receipt and dispute are mutually exclusive', async () => {
    // Create & fulfill pharmacy order for patient 1
    const orderRes = await request(app)
      .post('/pharmacy-orders')
      .set('Authorization', `Bearer ${patient1Token}`)
      .send({ patientProfileId: patient1ProfileId, details: 'Ibuprofen 400mg' });
    const orderId = orderRes.body.id;

    await request(app)
      .post(`/pharmacy-orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${facility1Token}`)
      .send({ referenceNumber: 'REF-PAT-1' });

    // Patient 2 (not owner) attempts confirm -> 403 or 404
    const p2Confirm = await request(app)
      .post(`/orders/${orderId}/confirm-receipt`)
      .set('Authorization', `Bearer ${patient2Token}`);
    expect(p2Confirm.status).toBe(403);

    // Patient 1 confirms receipt
    const confirmRes = await request(app)
      .post(`/orders/${orderId}/confirm-receipt`)
      .set('Authorization', `Bearer ${patient1Token}`);
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.confirmed).toBe(true);
    expect(confirmRes.body.confirmationSource).toBe('patient');
    expect(confirmRes.body.confirmedSignal).toBe(true);

    // Patient 1 attempts to dispute confirmed order -> 409 Conflict
    const disputeRes = await request(app)
      .post(`/orders/${orderId}/dispute`)
      .set('Authorization', `Bearer ${patient1Token}`)
      .send({ reason: 'Damaged package' });
    expect(disputeRes.status).toBe(409);
  });

  it('disputing an order prevents receipt confirmation and appears in admin dispute queue', async () => {
    // Create & fulfill lab order for patient 1
    const orderRes = await request(app)
      .post('/lab-orders')
      .set('Authorization', `Bearer ${patient1Token}`)
      .send({ patientProfileId: patient1ProfileId, details: 'Blood Panel Test' });
    const orderId = orderRes.body.id;

    await request(app)
      .post(`/lab-orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${facility1Token}`)
      .send({ referenceNumber: 'REF-LAB-001' });

    // Dispute without reason -> 400 Bad Request
    const noReason = await request(app)
      .post(`/orders/${orderId}/dispute`)
      .set('Authorization', `Bearer ${patient1Token}`)
      .send({ reason: ' ' });
    expect(noReason.status).toBe(400);

    // Dispute with reason -> 200
    const disputeRes = await request(app)
      .post(`/orders/${orderId}/dispute`)
      .set('Authorization', `Bearer ${patient1Token}`)
      .send({ reason: 'Sample results missing' });
    expect(disputeRes.status).toBe(200);
    expect(disputeRes.body.disputed).toBe(true);

    // Attempting confirm receipt now -> 409 Conflict
    const confirmRes = await request(app)
      .post(`/orders/${orderId}/confirm-receipt`)
      .set('Authorization', `Bearer ${patient1Token}`);
    expect(confirmRes.status).toBe(409);

    // Admin lists disputes
    const adminQueue = await request(app)
      .get('/admin/orders/disputes')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminQueue.status).toBe(200);
    expect(adminQueue.body.length).toBeGreaterThan(0);
    const disputeItem = adminQueue.body.find((d: any) => d.orderId === orderId);
    expect(disputeItem).toBeTruthy();
    expect(disputeItem.reason).toBe('Sample results missing');
    expect(disputeItem.status).toBe('pending');

    // Admin resolves dispute
    const resolveRes = await request(app)
      .post(`/admin/orders/disputes/${disputeItem.id}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        resolutionNotes: 'Refund issued to patient account',
        outcome: 'refunded',
      });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.dispute.status).toBe('resolved');
    expect(resolveRes.body.dispute.resolutions).toHaveLength(1);
    expect(resolveRes.body.dispute.resolutions[0].outcome).toBe('refunded');

    // Note: resolving dispute does NOT mark order as confirmed!
    const updatedOrder = await request(app)
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${patient1Token}`);
    expect(updatedOrder.body.confirmed).toBe(false);
  });

  it('expiry job auto-confirms unconfirmed orders past window and NEVER confirms disputed orders', async () => {
    // 1. Order A: fulfilled, past window -> should be auto-confirmed with confirmationSource: 'timeout'
    const orderARes = await request(app)
      .post('/pharmacy-orders')
      .set('Authorization', `Bearer ${patient1Token}`)
      .send({ patientProfileId: patient1ProfileId, details: 'Metformin 500mg' });
    const orderAId = orderARes.body.id;

    await request(app)
      .post(`/pharmacy-orders/${orderAId}/fulfill`)
      .set('Authorization', `Bearer ${facility1Token}`)
      .send({ referenceNumber: 'REF-EXP-A' });

    // Backdate fulfilledAt 100 hours ago (> 72 hr default window)
    const hundredHoursAgo = new Date(Date.now() - 100 * 60 * 60 * 1000);
    await prisma.order.update({
      where: { id: orderAId },
      data: { fulfilledAt: hundredHoursAgo },
    });

    // 2. Order B: fulfilled, past window, BUT disputed -> must NOT be auto-confirmed
    const orderBRes = await request(app)
      .post('/pharmacy-orders')
      .set('Authorization', `Bearer ${patient1Token}`)
      .send({ patientProfileId: patient1ProfileId, details: 'Omeprazole 20mg' });
    const orderBId = orderBRes.body.id;

    await request(app)
      .post(`/pharmacy-orders/${orderBId}/fulfill`)
      .set('Authorization', `Bearer ${facility1Token}`)
      .send({ referenceNumber: 'REF-EXP-B' });

    await request(app)
      .post(`/orders/${orderBId}/dispute`)
      .set('Authorization', `Bearer ${patient1Token}`)
      .send({ reason: 'Incorrect dosage provided' });

    await prisma.order.update({
      where: { id: orderBId },
      data: { fulfilledAt: hundredHoursAgo },
    });

    // Run expiry job
    const { confirmedCount } = await expireUnconfirmedOrders(72);
    expect(confirmedCount).toBeGreaterThanOrEqual(1);

    // Verify Order A is confirmed
    const orderA = await prisma.order.findUniqueOrThrow({ where: { id: orderAId } });
    expect(orderA.confirmed).toBe(true);
    expect(orderA.confirmationSource).toBe('timeout');

    // Verify Order B remains unconfirmed
    const orderB = await prisma.order.findUniqueOrThrow({ where: { id: orderBId } });
    expect(orderB.confirmed).toBe(false);
    expect(orderB.disputed).toBe(true);

    // Re-running expiry job -> idempotent
    const rerun = await expireUnconfirmedOrders(72);
    expect(rerun.confirmedCount).toBe(0);
  });
});
