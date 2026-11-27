// Integration tests for issues #312 (prescription quantities and the
// over-dispensing guard), #313 (lab-order TTL at issuance and the audited
// expiry sweep) and #314 (GET /prescriptions/:id and GET /lab-orders/:id per
// role, AccessLog rows, lab notes decrypted for clinical roles only).
// Setup mirrors orders-issuance.test.mts. Port 5497.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { shiftSlotToPast } from './helpers/fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5497;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-order-detail-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
// Must be set before src/db/prisma-client.ts builds the client at import time
// (vitest.config.mts points DATABASE_URL at booking.test.mts's cluster).
process.env.DATABASE_URL = databaseUrl;

const emailedTokens = new Map<string, string>();

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

const PASSWORD = 'longenough123';
const ITEM = { drugName: 'Amoxicillin', dosage: '500 mg', frequency: 'three times daily', duration: '7 days', quantity: 21, unit: 'tablets' };

describe('issues #312-#314: order quantities, lab-order expiry and detail reads', () => {
  let app: App;
  let prisma: Prisma;

  let treatingDoctorToken: string;
  let treatingDoctorProfileId: string;
  let otherDoctorToken: string;
  let patientToken: string;
  let patientProfileId: string;
  let facilityToken: string;
  let adminToken: string;
  let pharmacyId: string;
  let labId: string;

  /** Closed consultation (outcome set) on a completed appointment. */
  let closedConsultationId: string;
  /** Open consultation (no outcome yet) on a completed appointment. */
  let openConsultationId: string;

  const prescriptionUrl = (id: string) => `/orders/consultations/${id}/prescriptions`;
  const labOrderUrl = (id: string) => `/orders/consultations/${id}/lab-orders`;

  const prescriptionBody = () => ({ facilityProfileId: pharmacyId, amountStroops: '1500000', items: [ITEM] });
  const labOrderBody = () => ({ facilityProfileId: labId, amountStroops: '2500000', testType: 'Full blood count', urgency: 'urgent', notes: 'Fasting sample.' });

  async function signup(role: 'doctor' | 'patient', email: string, verify: boolean) {
    const res = await request(app).post('/auth/signup').send({ role, email, password: PASSWORD, fullName: `I314 ${role}` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (verify) {
      const token = emailedTokens.get(email);
      expect(token, `no verification email captured for ${email}`).toBeTruthy();
      const verified = await request(app).post('/auth/verify-email').send({ token });
      expect(verified.status).toBe(200);
    }
    return { token: res.body.accessToken as string, userId: res.body.user.id as string };
  }

  async function staffUser(role: 'facility' | 'admin', email: string) {
    const bcryptjs = await import('bcryptjs');
    const user = await prisma.user.create({
      data: { email, passwordHash: await bcryptjs.hash(PASSWORD, 4), role, emailVerifiedAt: new Date() },
    });
    const login = await request(app).post('/auth/login').send({ email, password: PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    return { user, token: login.body.accessToken as string };
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

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;
    authServices.setEmailSender(async (message) => {
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
    });

    const treating = await signup('doctor', `i314-treating-${runId}@example.com`, true);
    const other = await signup('doctor', `i314-other-${runId}@example.com`, true);
    const unverifiedEmail = await signup('doctor', `i314-unverified-${runId}@example.com`, false);
    const patient = await signup('patient', `i314-patient-${runId}@example.com`, true);
    treatingDoctorToken = treating.token;
    otherDoctorToken = other.token;
    patientToken = patient.token;

    // Admin verification of the doctor profiles is its own flow (Phase 1);
    // set it directly so every doctor here is a verified one.
    await prisma.doctorProfile.updateMany({
      where: { userId: { in: [treating.userId, other.userId, unverifiedEmail.userId] } },
      data: { verificationStatus: 'verified' },
    });
    treatingDoctorProfileId = (await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: treating.userId } })).id;
    patientProfileId = (await prisma.patientProfile.findUniqueOrThrow({ where: { userId: patient.userId } })).id;

    const facility = await staffUser('facility', `i314-pharmacy-${runId}@example.com`);
    facilityToken = facility.token;
    pharmacyId = (await prisma.facilityProfile.create({ data: { userId: facility.user.id, name: `Pharmacy ${runId}`, type: 'pharmacy' } })).id;
    const labUser = await prisma.user.create({
      data: { email: `i314-lab-${runId}@example.com`, passwordHash: 'unused', role: 'facility', emailVerifiedAt: new Date() },
    });
    labId = (await prisma.facilityProfile.create({ data: { userId: labUser.id, name: `Lab ${runId}`, type: 'lab' } })).id;
    adminToken = (await staffUser('admin', `i314-admin-${runId}@example.com`)).token;

    // Four appointments with the treating doctor.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const generate = await request(app)
      .post(`/availability/doctors/${treatingDoctorProfileId}/slots/generate`)
      .set('Authorization', `Bearer ${treatingDoctorToken}`)
      .send({ date: tomorrow, startHour: 9, endHour: 11, slotLengthMinutes: 30 });
    expect(generate.status, JSON.stringify(generate.body)).toBe(201);
    const slots = await request(app).get(`/availability/doctors/${treatingDoctorProfileId}/slots`);
    expect(slots.body.length).toBeGreaterThanOrEqual(4);

    const appointmentIds: string[] = [];
    for (const slot of slots.body.slice(0, 4)) {
      const book = await request(app).post('/appointments').set('Authorization', `Bearer ${patientToken}`).send({ availabilitySlotId: slot.id });
      expect(book.status, JSON.stringify(book.body)).toBe(201);
      appointmentIds.push(book.body.id);
    }
    const [closedAppt, openAppt, , cancelledAppt] = appointmentIds;

    for (const id of [closedAppt, openAppt]) {
      const apt = await prisma.appointment.findUniqueOrThrow({ where: { id } });
      await shiftSlotToPast(prisma, apt.availabilitySlotId!);
      const done = await request(app).patch(`/appointments/${id}/status`).set('Authorization', `Bearer ${treatingDoctorToken}`).send({ status: 'completed' });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    }
    const cancel = await request(app).patch(`/appointments/${cancelledAppt}/status`).set('Authorization', `Bearer ${treatingDoctorToken}`).send({ status: 'cancelled' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

    const closed = await request(app)
      .post(`/appointments/${closedAppt}/consultation`)
      .set('Authorization', `Bearer ${treatingDoctorToken}`)
      .send({ outcome: 'resolved', notes: 'Bacterial infection; antibiotics.' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    closedConsultationId = closed.body.consultation.id;

    const open = await request(app)
      .post('/consultations')
      .set('Authorization', `Bearer ${treatingDoctorToken}`)
      .send({ appointmentId: openAppt });
    expect(open.status, JSON.stringify(open.body)).toBe(201);
    expect(open.body.outcome).toBeNull();
    openConsultationId = open.body.id;

  });

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  let prescriptionId: string;
  let labOrderId: string;
  let routineLabOrderId: string;
  let guardianToken: string;
  let otherFacilityToken: string;
  let labToken: string;
  const ORDERED_QTY = ITEM.quantity;

  async function accessLogsFor(entityId: string, expected: number) {
    // AccessLog writes are fire-and-forget; give them a moment to land.
    for (let i = 0; i < 40; i += 1) {
      const rows = await prisma.accessLog.findMany({ where: { entityId } });
      if (rows.length >= expected) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return prisma.accessLog.findMany({ where: { entityId } });
  }

  it('issues orders carrying quantity/unit and lab-order expiry from the TTL config', async () => {
    const rx = await request(app)
      .post(prescriptionUrl(closedConsultationId))
      .set('Authorization', `Bearer ${treatingDoctorToken}`)
      .send(prescriptionBody());
    expect(rx.status, JSON.stringify(rx.body)).toBe(201);
    expect(rx.body.items[0]).toMatchObject({ quantity: 21, unit: 'tablets' });
    prescriptionId = rx.body.id;

    const before = Date.now();
    const urgent = await request(app)
      .post(labOrderUrl(closedConsultationId))
      .set('Authorization', `Bearer ${treatingDoctorToken}`)
      .send(labOrderBody());
    expect(urgent.status, JSON.stringify(urgent.body)).toBe(201);
    labOrderId = urgent.body.id;
    const routine = await request(app)
      .post(labOrderUrl(openConsultationId))
      .set('Authorization', `Bearer ${treatingDoctorToken}`)
      .send({ ...labOrderBody(), urgency: 'routine', testType: 'Lipid panel' });
    expect(routine.status, JSON.stringify(routine.body)).toBe(201);
    routineLabOrderId = routine.body.id;

    const day = 24 * 60 * 60 * 1000;
    const urgentRow = await prisma.labOrder.findUniqueOrThrow({ where: { id: labOrderId } });
    const routineRow = await prisma.labOrder.findUniqueOrThrow({ where: { id: routineLabOrderId } });
    expect(urgentRow.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 7 * day - 1000);
    expect(urgentRow.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 7 * day + 1000);
    expect(routineRow.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * day - 1000);
    expect(routineRow.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 30 * day + 1000);
  });

  it('refuses a prescription item without quantity or unit (#312)', async () => {
    const noQuantity = { drugName: ITEM.drugName, dosage: ITEM.dosage, frequency: ITEM.frequency, duration: ITEM.duration, unit: ITEM.unit };
    const noUnit = { drugName: ITEM.drugName, dosage: ITEM.dosage, frequency: ITEM.frequency, duration: ITEM.duration, quantity: ITEM.quantity };
    for (const item of [noQuantity, noUnit, { ...ITEM, quantity: 0 }]) {
      const res = await request(app)
        .post(prescriptionUrl(openConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send({ ...prescriptionBody(), items: [item] });
      expect(res.status).toBe(400);
    }
  });

  it('rejects over-dispensing and accepts exact dispensing against the ordered quantity (#312)', async () => {
    const routed = await request(app)
      .post('/pharmacy-orders/fulfillments')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({ orderType: 'prescription', orderId: prescriptionId, facilityId: pharmacyId });
    expect(routed.status, JSON.stringify(routed.body)).toBe(201);
    const record = await prisma.fulfillmentRecord.findFirstOrThrow({ where: { prescriptionId, facilityId: pharmacyId }, include: { items: true } });
    expect(record.items).toHaveLength(1);
    expect(record.items[0].quantityOrdered).toBe(ORDERED_QTY);
    const itemUrl = `/pharmacy-orders/fulfillments/${record.id}/items/${record.items[0].id}`;

    const over = await request(app)
      .patch(itemUrl)
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ status: 'dispensed', quantityDispensed: ORDERED_QTY + 1 });
    expect(over.status, JSON.stringify(over.body)).toBe(400);
    expect((await prisma.fulfillmentItem.findUniqueOrThrow({ where: { id: record.items[0].id } })).status).toBe('pending');

    const exact = await request(app)
      .patch(itemUrl)
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ status: 'dispensed', quantityDispensed: ORDERED_QTY });
    expect(exact.status, JSON.stringify(exact.body)).toBe(200);
    const item = await prisma.fulfillmentItem.findUniqueOrThrow({ where: { id: record.items[0].id } });
    expect(item).toMatchObject({ status: 'dispensed', quantityDispensed: ORDERED_QTY });
  });

  describe('detail reads per role (#314)', () => {
    beforeAll(async () => {
      // A guardian: the dependent must be a minor for the guardianship to be active.
      await prisma.patientProfile.update({ where: { id: patientProfileId }, data: { dateOfBirth: new Date('2015-06-01') } });
      const guardian = await signup('patient', `i314-guardian-${runId}@example.com`, true);
      guardianToken = guardian.token;
      await prisma.guardianship.create({ data: { guardianUserId: guardian.userId, dependentProfileId: patientProfileId } });
      const other = await staffUser('facility', `i314-otherpharmacy-${runId}@example.com`);
      otherFacilityToken = other.token;
      await prisma.facilityProfile.create({ data: { userId: other.user.id, name: `Other ${runId}`, type: 'pharmacy' } });
      const bcryptjs = await import('bcryptjs');
      await prisma.user.update({ where: { email: `i314-lab-${runId}@example.com` }, data: { passwordHash: await bcryptjs.hash(PASSWORD, 4) } });
      const labLogin = await request(app).post('/auth/login').send({ email: `i314-lab-${runId}@example.com`, password: PASSWORD });
      labToken = labLogin.body.accessToken as string;
    });

    it('serves a prescription to the prescriber, patient, guardian, assigned facility and admin with links and payment status', async () => {
      const readers = { treatingDoctorToken, patientToken, guardianToken, facilityToken, adminToken };
      for (const [who, token] of Object.entries(readers)) {
        const res = await request(app).get(`/prescriptions/${prescriptionId}`).set('Authorization', `Bearer ${token}`);
        expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(200);
        expect(res.body).toMatchObject({
          id: prescriptionId,
          status: expect.any(String),
          amountStroops: '1500000',
          supersedesPrescriptionId: null,
          correctedByPrescriptionId: null,
          paymentIntentStatus: expect.any(String),
        });
        expect(res.body.items[0]).toMatchObject({ drugName: ITEM.drugName, quantity: 21, unit: 'tablets' });
      }
      const logs = await accessLogsFor(prescriptionId, Object.keys(readers).length);
      expect(logs).toHaveLength(Object.keys(readers).length);
      expect(logs.every((row) => row.entityType === 'Prescription' && row.patientProfileId === patientProfileId)).toBe(true);
    });

    it('answers 404 to another doctor, an unrelated facility and for an unknown id, without logging', async () => {
      for (const token of [otherDoctorToken, otherFacilityToken]) {
        const res = await request(app).get(`/prescriptions/${prescriptionId}`).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(404);
      }
      expect((await request(app).get('/prescriptions/00000000-0000-0000-0000-000000000000').set('Authorization', `Bearer ${adminToken}`)).status).toBe(404);
      expect((await request(app).get(`/prescriptions/${prescriptionId}`)).status).toBe(401);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await prisma.accessLog.count({ where: { entityId: prescriptionId } })).toBe(5);
    });

    it('points a superseded prescription at its correction', async () => {
      const first = await request(app)
        .post(prescriptionUrl(openConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send(prescriptionBody());
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const correction = await request(app)
        .post(prescriptionUrl(openConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send({ ...prescriptionBody(), supersedesPrescriptionId: first.body.id });
      expect(correction.status, JSON.stringify(correction.body)).toBe(201);
      const original = await request(app).get(`/prescriptions/${first.body.id}`).set('Authorization', `Bearer ${adminToken}`);
      expect(original.status).toBe(200);
      expect(original.body.correctedByPrescriptionId).toBe(correction.body.id);
      const fresh = await request(app).get(`/prescriptions/${correction.body.id}`).set('Authorization', `Bearer ${adminToken}`);
      expect(fresh.body).toMatchObject({ supersedesPrescriptionId: first.body.id, correctedByPrescriptionId: null });
    });

    it('serves a lab order per role, decrypting notes for the ordering doctor and admin only', async () => {
      const clinical = { treatingDoctorToken, adminToken };
      const nonClinical = { patientToken, guardianToken, labToken };
      for (const [who, token] of Object.entries(clinical)) {
        const res = await request(app).get(`/lab-orders/${labOrderId}`).set('Authorization', `Bearer ${token}`);
        expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(200);
        expect(res.body).toMatchObject({ id: labOrderId, notes: 'Fasting sample.', paymentIntentStatus: 'created', correctedByLabOrderId: null });
      }
      for (const [who, token] of Object.entries(nonClinical)) {
        const res = await request(app).get(`/lab-orders/${labOrderId}`).set('Authorization', `Bearer ${token}`);
        expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(200);
        expect(res.body.notes).toBeNull();
        expect(JSON.stringify(res.body)).not.toContain('Fasting sample.');
      }
      for (const token of [otherDoctorToken, otherFacilityToken, facilityToken]) {
        expect((await request(app).get(`/lab-orders/${labOrderId}`).set('Authorization', `Bearer ${token}`)).status).toBe(404);
      }
      const logs = await accessLogsFor(labOrderId, 5);
      expect(logs).toHaveLength(5);
      expect(logs.every((row) => row.entityType === 'LabOrder')).toBe(true);
    });
  });

  it('expires an issued lab order past its TTL with an AuditEvent, and never a fulfilled one (#313)', async () => {
    const { runExpireUnfulfilledOrders } = await import('../../src/jobs/lab-order-expiry.js');
    // The routine order is fulfilled; the urgent one is left issued.
    await prisma.labOrder.update({ where: { id: routineLabOrderId }, data: { status: 'fulfilled' } });
    const later = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    const result = await runExpireUnfulfilledOrders(later);
    expect(result.expired).toBeGreaterThanOrEqual(1);

    expect((await prisma.labOrder.findUniqueOrThrow({ where: { id: labOrderId } })).status).toBe('expired');
    expect((await prisma.labOrder.findUniqueOrThrow({ where: { id: routineLabOrderId } })).status).toBe('fulfilled');
    const events = await prisma.auditEvent.findMany({ where: { entityType: 'LabOrder', entityId: labOrderId, action: 'lab_order.expired' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromState: 'issued', toState: 'expired', actorUserId: null });
    expect(await prisma.auditEvent.count({ where: { entityId: routineLabOrderId, action: 'lab_order.expired' } })).toBe(0);

    // A second run changes nothing and writes no second event.
    await runExpireUnfulfilledOrders(later);
    expect(await prisma.auditEvent.count({ where: { entityId: labOrderId, action: 'lab_order.expired' } })).toBe(1);
  });
});
