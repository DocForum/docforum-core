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
const PROOF_MAX_BYTES = 4096;
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 0x20)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

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
    // Small proof cap so the size limit is cheap to exercise (issue #316).
    process.env.FULFILLMENT_PROOF_MAX_BYTES = String(PROOF_MAX_BYTES);

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
      .set('Authorization', `Bearer ${adminToken}`)
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

    // 4. A client-supplied attachment (URL or inline data) is refused: the
    //    file goes through the upload route instead (issue #316).
    const withUrl = await request(app)
      .post(`/pharmacy-orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${facility1Token}`)
      .send({ referenceNumber: 'REF-PHARM-99', attachment: { url: 'https://evil.example/receipt.pdf' } });
    expect(withUrl.status).toBe(400);

    // 5. Facility fulfills with reference number -> 200, proof without file
    const fulfillRes = await request(app)
      .post(`/pharmacy-orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${facility1Token}`)
      .send({
        referenceNumber: 'REF-PHARM-99',
        notes: 'Dispensed 30 capsules',
      });

    expect(fulfillRes.status).toBe(200);
    expect(fulfillRes.body.status).toBe('fulfilled');
    expect(fulfillRes.body.fulfillmentProofs).toHaveLength(1);
    expect(fulfillRes.body.fulfillmentProofs[0].referenceNumber).toBe('REF-PHARM-99');
    expect(fulfillRes.body.fulfillmentProofs[0]).toMatchObject({
      attachmentContentType: null,
      attachmentByteSize: null,
      legacyAttachmentUrl: null,
    });
    // The storage key never leaves the server.
    expect(fulfillRes.body.fulfillmentProofs[0]).not.toHaveProperty('attachmentObjectKey');

    // 6. Trying to fulfill again -> 409 Conflict
    const secondFulfill = await request(app)
      .post(`/pharmacy-orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${facility1Token}`)
      .send({ referenceNumber: 'REF-DUP' });
    expect(secondFulfill.status).toBe(409);
  });

  it('stores proof files privately and serves them only to the patient, the facility and admins (issue #316)', async () => {
    const orderRes = await request(app)
      .post('/pharmacy-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ patientProfileId: patient1ProfileId, details: 'Proof file order' });
    const orderId = orderRes.body.id as string;
    const fulfilled = await request(app)
      .post(`/pharmacy-orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${facility1Token}`)
      .send({ referenceNumber: 'REF-PROOF-1' });
    expect(fulfilled.status).toBe(200);
    const proofId = fulfilled.body.fulfillmentProofs[0].id as string;

    // A second facility, which did not record this proof.
    const bcryptjs = await import('bcryptjs');
    const otherFacilityUser = await prisma.user.create({
      data: {
        email: `facility2-${runId}@example.com`,
        passwordHash: await bcryptjs.hash('longenough123', 4),
        role: 'facility',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.facilityProfile.create({ data: { userId: otherFacilityUser.id, name: `Other ${runId}`, type: 'pharmacy' } });
    const otherFacilityToken = (
      await request(app).post('/auth/login').send({ email: `facility2-${runId}@example.com`, password: 'longenough123' })
    ).body.accessToken as string;

    const upload = (token: string, body: Buffer, type: string) =>
      request(app)
        .put(`/fulfillment-proofs/${proofId}/attachment`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', type)
        .send(body);
    const download = (token: string) =>
      request(app).get(`/fulfillment-proofs/${proofId}/attachment`).set('Authorization', `Bearer ${token}`);

    // Before anything is attached there is nothing to download.
    expect((await download(patient1Token)).status).toBe(404);

    // Content-type allowlist, magic bytes, size cap, ownership.
    expect((await upload(facility1Token, Buffer.from('<html></html>'), 'text/html')).status).toBe(415);
    const mismatch = await upload(facility1Token, Buffer.from('not really a pdf'), 'application/pdf');
    expect(mismatch.status).toBe(415);
    expect(mismatch.body.code).toBe('PROOF_CONTENT_MISMATCH');
    const tooBig = await upload(facility1Token, Buffer.concat([PDF, Buffer.alloc(PROOF_MAX_BYTES, 0x20)]), 'application/pdf');
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.code).toBe('PROOF_TOO_LARGE');
    expect((await upload(otherFacilityToken, PDF, 'application/pdf')).status).toBe(404);
    expect((await upload(patient1Token, PDF, 'application/pdf')).status).toBe(403);

    // The recording facility attaches a real PDF, once.
    const attached = await upload(facility1Token, PDF, 'application/pdf');
    expect(attached.status).toBe(201);
    expect(attached.body).toEqual({ proofId, orderId, contentType: 'application/pdf', byteSize: PDF.length });
    const again = await upload(facility1Token, PNG, 'image/png');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PROOF_ALREADY_ATTACHED');

    const row = await prisma.fulfillmentProof.findUniqueOrThrow({ where: { id: proofId } });
    expect(row.attachmentObjectKey).toMatch(/^fulfillment-proofs\/[0-9a-f-]{36}$/);
    expect(row.attachmentObjectKey).not.toContain(orderId);
    expect(await prisma.auditEvent.count({ where: { entityType: 'FulfillmentProof', entityId: proofId, action: 'fulfillment_proof.attached' } })).toBe(1);

    // Patient owner, recording facility and admin can read it...
    for (const token of [patient1Token, facility1Token, adminToken]) {
      const res = await download(token).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0);
    }
    // ...and the patient's read is in their access log.
    // (recordAccess is fire-and-forget, so give the write a moment.)
    let logged = 0;
    for (let i = 0; i < 20 && logged === 0; i += 1) {
      logged = await prisma.accessLog.count({ where: { entityType: 'FulfillmentProof', entityId: proofId, patientProfileId: patient1ProfileId } });
      if (logged === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(logged).toBeGreaterThan(0);
    // ...nobody else can (same 404 as a missing proof).
    expect((await download(patient2Token)).status).toBe(404);
    expect((await download(otherFacilityToken)).status).toBe(404);
    expect((await request(app).get(`/fulfillment-proofs/${proofId}/attachment`)).status).toBe(401);

    // Order reads show the file's metadata, never the storage key.
    const order = await request(app).get(`/pharmacy-orders/${orderId}`).set('Authorization', `Bearer ${patient1Token}`);
    expect(order.body.fulfillmentProofs[0]).toMatchObject({ attachmentContentType: 'application/pdf', attachmentByteSize: PDF.length });
    expect(order.body.fulfillmentProofs[0]).not.toHaveProperty('attachmentObjectKey');
  });

  it('keeps a pre-#316 client-supplied proof URL readable but untrusted, and never serves it', async () => {
    const orderRes = await request(app)
      .post('/lab-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ patientProfileId: patient1ProfileId, details: 'Legacy proof order' });
    const orderId = orderRes.body.id as string;
    const fulfilled = await request(app)
      .post(`/lab-orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${facility1Token}`)
      .send({ referenceNumber: 'REF-LEGACY' });
    expect(fulfilled.status).toBe(200);
    const proofId = fulfilled.body.fulfillmentProofs[0].id as string;
    // What the old endpoint stored as attachmentUrl (renamed by the migration).
    await prisma.fulfillmentProof.update({
      where: { id: proofId },
      data: { legacyAttachmentUrl: 'https://evil.example/phish' },
    });

    const order = await request(app).get(`/orders/${orderId}`).set('Authorization', `Bearer ${patient1Token}`);
    expect(order.body.fulfillmentProofs[0]).toMatchObject({ legacyAttachmentUrl: 'https://evil.example/phish', attachmentContentType: null });
    const res = await request(app).get(`/fulfillment-proofs/${proofId}/attachment`).set('Authorization', `Bearer ${patient1Token}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROOF_FILE_NOT_FOUND');
  });

  it('legacy order reads are limited to the patient, the routed facility and admins', async () => {
    const created = await request(app)
      .post('/pharmacy-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ patientProfileId: patient1ProfileId, details: 'Access check order' });
    expect(created.status).toBe(201);
    const orderId = created.body.id as string;

    // Not routed yet: only the patient and admins can read it.
    for (const path of [`/orders/${orderId}`, `/pharmacy-orders/${orderId}`]) {
      expect((await request(app).get(path).set('Authorization', `Bearer ${patient1Token}`)).status).toBe(200);
      expect((await request(app).get(path).set('Authorization', `Bearer ${adminToken}`)).status).toBe(200);
      expect((await request(app).get(path).set('Authorization', `Bearer ${patient2Token}`)).status).toBe(404);
      expect((await request(app).get(path).set('Authorization', `Bearer ${facility1Token}`)).status).toBe(404);
    }

    // Once a facility fulfils it the order is routed to that facility, which
    // can then read it.
    const fulfilled = await request(app)
      .post(`/pharmacy-orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${facility1Token}`)
      .send({ referenceNumber: 'REF-ACCESS' });
    expect(fulfilled.status).toBe(200);
    expect((await request(app).get(`/orders/${orderId}`).set('Authorization', `Bearer ${facility1Token}`)).status).toBe(200);
    expect((await request(app).get(`/orders/${orderId}`).set('Authorization', `Bearer ${patient2Token}`)).status).toBe(404);

    // Successful reads leave an AccessLog row (written fire-and-forget).
    let logged = 0;
    for (let i = 0; i < 20 && logged === 0; i += 1) {
      logged = await prisma.accessLog.count({ where: { entityType: 'Order', entityId: orderId, patientProfileId: patient1ProfileId } });
      if (logged === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(logged).toBeGreaterThan(0);
  });

  it('legacy order creation is admin-only', async () => {
    for (const path of ['/pharmacy-orders', '/lab-orders']) {
      for (const token of [patient1Token, facility1Token]) {
        const res = await request(app)
          .post(path)
          .set('Authorization', `Bearer ${token}`)
          .send({ patientProfileId: patient1ProfileId, details: 'Should be refused' });
        expect(res.status).toBe(403);
      }
    }
  });

  it('patient confirm-receipt and dispute are mutually exclusive', async () => {
    // Create & fulfill pharmacy order for patient 1
    const orderRes = await request(app)
      .post('/pharmacy-orders')
      .set('Authorization', `Bearer ${adminToken}`)
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
      .set('Authorization', `Bearer ${adminToken}`)
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
    // Issue #311: the queue is keyset-paginated ({ items, nextCursor }).
    expect(adminQueue.body.items.length).toBeGreaterThan(0);
    const disputeItem = adminQueue.body.items.find((d: any) => d.orderId === orderId);
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

    // Issue #311: resolution is a one-way pending → resolved transition.
    const secondResolve = await request(app)
      .post(`/admin/orders/disputes/${disputeItem.id}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolutionNotes: 'Second attempt', outcome: 'rejected' });
    expect(secondResolve.status).toBe(409);
    const resolutionRows = await prisma.orderDisputeResolution.count({ where: { disputeId: disputeItem.id } });
    expect(resolutionRows).toBe(1);

    const missingResolve = await request(app)
      .post('/admin/orders/disputes/00000000-0000-4000-8000-000000000000/resolve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolutionNotes: 'No such dispute', outcome: 'upheld' });
    expect(missingResolve.status).toBe(404);

    const badOutcome = await request(app)
      .post(`/admin/orders/disputes/${disputeItem.id}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolutionNotes: 'Free text outcome', outcome: 'resolved' });
    expect(badOutcome.status).toBe(400);

    const badStatus = await request(app)
      .get('/admin/orders/disputes?status=closed')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(badStatus.status).toBe(400);

    // Keyset pagination: walk the resolved queue one row at a time.
    const firstPage = await request(app)
      .get('/admin/orders/disputes?status=resolved&limit=1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items).toHaveLength(1);
    expect(firstPage.body.items[0].status).toBe('resolved');
    if (firstPage.body.nextCursor) {
      const nextPage = await request(app)
        .get(`/admin/orders/disputes?status=resolved&limit=1&cursor=${firstPage.body.nextCursor}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(nextPage.status).toBe(200);
      expect(nextPage.body.items.map((d: any) => d.id)).not.toContain(firstPage.body.items[0].id);
    }

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
      .set('Authorization', `Bearer ${adminToken}`)
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
      .set('Authorization', `Bearer ${adminToken}`)
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
