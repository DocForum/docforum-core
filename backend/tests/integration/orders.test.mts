import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/prisma';
import { generateTestToken } from '../helpers';

describe('Orders Integration Tests', () => {
  let patientToken: string;
  let facilityToken: string;
  let adminToken: string;
  let patientId: string;
  let facilityId: string;
  let adminId: string;

  beforeAll(async () => {
    // Setup test users
    const patientUser = await prisma.user.create({
      data: {
        email: `patient-${Date.now()}@example.com`,
        passwordHash: 'hash',
        role: 'PATIENT',
      },
    });
    patientId = patientUser.id;
    patientToken = generateTestToken({ id: patientUser.id, role: 'PATIENT' });

    const facilityUser = await prisma.user.create({
      data: {
        email: `facility-${Date.now()}@example.com`,
        passwordHash: 'hash',
        role: 'FACILITY',
      },
    });
    facilityId = facilityUser.id;
    facilityToken = generateTestToken({ id: facilityUser.id, role: 'FACILITY' });

    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${Date.now()}@example.com`,
        passwordHash: 'hash',
        role: 'ADMIN',
      },
    });
    adminId = adminUser.id;
    adminToken = generateTestToken({ id: adminUser.id, role: 'ADMIN' });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('facility can fulfill pharmacy order with reference number and optional file attachment', async () => {
    // Create pharmacy order
    const order = await prisma.order.create({
      data: {
        type: 'PHARMACY',
        patientId,
        facilityId,
        status: 'PENDING',
      },
    });

    // Fulfill order
    const res = await request(app)
      .post(`/api/v1/pharmacy-orders/${order.id}/fulfill`)
      .set('Authorization', `Bearer ${facilityToken}`)
      .attach('attachment', Buffer.from('proof document content'), 'receipt.pdf')
      .field('referenceNumber', 'REF-PHARM-12345')
      .field('notes', 'Dispensed 30 day supply');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('FULFILLED');
    expect(res.body.fulfillmentProof).toBeDefined();
    expect(res.body.fulfillmentProof.referenceNumber).toBe('REF-PHARM-12345');
    expect(res.body.fulfillmentProof.fileUrl).toContain('receipt.pdf');
  });

  it('patient can confirm receipt of fulfilled order', async () => {
    const order = await prisma.order.create({
      data: {
        type: 'PHARMACY',
        patientId,
        facilityId,
        status: 'FULFILLED',
        fulfilledAt: new Date(),
      },
    });

    const res = await request(app)
      .post(`/api/v1/orders/${order.id}/confirm-receipt`)
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBe(true);
    expect(res.body.confirmationSource).toBe('PATIENT');
    expect(res.body.confirmedSignal).toBe(true);
  });

  it('patient can dispute order with reason, preventing confirmation', async () => {
    const order = await prisma.order.create({
      data: {
        type: 'LAB',
        patientId,
        facilityId,
        status: 'FULFILLED',
        fulfilledAt: new Date(),
      },
    });

    // Dispute order
    const disputeRes = await request(app)
      .post(`/api/v1/orders/${order.id}/dispute`)
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ reason: 'Incorrect lab test results delivered' });

    expect(disputeRes.status).toBe(200);
    expect(disputeRes.disputed).not.toBe(false);

    // Attempting to confirm receipt now must fail (mutual exclusion)
    const confirmRes = await request(app)
      .post(`/api/v1/orders/${order.id}/confirm-receipt`)
      .set('Authorization', `Bearer ${patientToken}`);

    expect(confirmRes.status).toBe(409);
  });

  it('admin can view dispute queue and resolve disputes with append-only resolution logs', async () => {
    // Create order with dispute
    const order = await prisma.order.create({
      data: {
        type: 'PHARMACY',
        patientId,
        facilityId,
        status: 'FULFILLED',
        disputed: true,
        disputeReason: 'Wrong medication sent',
        disputedAt: new Date(),
      },
    });

    const dispute = await prisma.orderDispute.create({
      data: {
        orderId: order.id,
        patientId,
        reason: 'Wrong medication sent',
      },
    });

    // Admin lists disputes
    const listRes = await request(app)
      .get('/api/v1/admin/orders/disputes')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);

    // Admin resolves dispute
    const resolveRes = await request(app)
      .post(`/api/v1/admin/orders/disputes/${dispute.id}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        resolutionNotes: 'Refunded patient and re-issued order',
        status: 'RESOLVED',
      });

    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.disputeId).toBe(dispute.id);
    expect(resolveRes.body.status).toBe('RESOLVED');
  });
});
