// Integration tests for issue #10: a doctor issues a Prescription or a
// LabOrder from a consultation (ROADMAP.md Phase 4).
//
// The endpoints are `POST /orders/consultations/:consultationId/prescriptions`
// and `POST /orders/consultations/:consultationId/lab-orders`. What this file
// proves, over HTTP against a real Postgres:
//   1. the treating doctor can issue both order types from an open ("active",
//      no outcome yet) or a closed ("completed") consultation, through the
//      append-only issuance path from #9 — one new row, its payment intent
//      and its audit event in one transaction;
//   2. a correction issued through the same endpoint creates a superseding
//      row and leaves the original exactly as it was;
//   3. access is restricted to the treating doctor: another (verified) doctor,
//      the treating doctor with an unverified profile, the consultation's own
//      patient, a facility, an admin and an anonymous caller are all refused,
//      and none of them leaves a row behind;
//   4. consultations whose appointment is not `completed` (scheduled,
//      cancelled) are refused with 409 — after the caller check, so another
//      doctor gets 403 and learns nothing about the state.
//
// Self-contained like the other integration suites: its own embedded
// Postgres on its own port (5467 — see consultation.test.mts for the list of
// ports already taken) with the committed migrations applied.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5467;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-order-issue-pg-'));
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
const ITEM = { drugName: 'Amoxicillin', dosage: '500 mg', frequency: 'three times daily', duration: '7 days' };

describe('issue #10: issuing prescriptions and lab orders from a consultation', () => {
  let app: App;
  let prisma: Prisma;

  let treatingDoctorToken: string;
  let treatingDoctorProfileId: string;
  let otherDoctorToken: string;
  let unverifiedEmailDoctorToken: string;
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
  /** Consultation rows whose appointment is not completed (written directly:
   * the API refuses to create them, which is exactly why the order path must
   * not trust that they can't exist). */
  let scheduledConsultationId: string;
  let cancelledConsultationId: string;

  const prescriptionUrl = (id: string) => `/orders/consultations/${id}/prescriptions`;
  const labOrderUrl = (id: string) => `/orders/consultations/${id}/lab-orders`;

  const prescriptionBody = () => ({ facilityProfileId: pharmacyId, amountStroops: '1500000', items: [ITEM] });
  const labOrderBody = () => ({ facilityProfileId: labId, amountStroops: '2500000', testType: 'Full blood count', urgency: 'urgent', notes: 'Fasting sample.' });

  async function signup(role: 'doctor' | 'patient', email: string, verify: boolean) {
    const res = await request(app).post('/auth/signup').send({ role, email, password: PASSWORD, fullName: `Issue10 ${role}` });
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

  async function orderCounts() {
    const [prescriptions, items, labOrders, intents] = await Promise.all([
      prisma.prescription.count(), prisma.prescriptionItem.count(), prisma.labOrder.count(), prisma.paymentIntent.count(),
    ]);
    return { prescriptions, items, labOrders, intents };
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

    const treating = await signup('doctor', `issue10-treating-${runId}@example.com`, true);
    const other = await signup('doctor', `issue10-other-${runId}@example.com`, true);
    const unverifiedEmail = await signup('doctor', `issue10-unverified-${runId}@example.com`, false);
    const patient = await signup('patient', `issue10-patient-${runId}@example.com`, true);
    treatingDoctorToken = treating.token;
    otherDoctorToken = other.token;
    unverifiedEmailDoctorToken = unverifiedEmail.token;
    patientToken = patient.token;

    // Admin verification of the doctor profiles is its own flow (Phase 1);
    // set it directly so every doctor here is a verified one.
    await prisma.doctorProfile.updateMany({
      where: { userId: { in: [treating.userId, other.userId, unverifiedEmail.userId] } },
      data: { verificationStatus: 'verified' },
    });
    treatingDoctorProfileId = (await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: treating.userId } })).id;
    patientProfileId = (await prisma.patientProfile.findUniqueOrThrow({ where: { userId: patient.userId } })).id;

    const facility = await staffUser('facility', `issue10-pharmacy-${runId}@example.com`);
    facilityToken = facility.token;
    pharmacyId = (await prisma.facilityProfile.create({ data: { userId: facility.user.id, name: `Pharmacy ${runId}`, type: 'pharmacy' } })).id;
    const labUser = await prisma.user.create({
      data: { email: `issue10-lab-${runId}@example.com`, passwordHash: 'unused', role: 'facility', emailVerifiedAt: new Date() },
    });
    labId = (await prisma.facilityProfile.create({ data: { userId: labUser.id, name: `Lab ${runId}`, type: 'lab' } })).id;
    adminToken = (await staffUser('admin', `issue10-admin-${runId}@example.com`)).token;

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
    const [closedAppt, openAppt, scheduledAppt, cancelledAppt] = appointmentIds;

    for (const id of [closedAppt, openAppt]) {
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

    scheduledConsultationId = (await prisma.consultation.create({ data: { appointmentId: scheduledAppt } })).id;
    cancelledConsultationId = (await prisma.consultation.create({ data: { appointmentId: cancelledAppt } })).id;
  });

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('treating doctor issues orders', () => {
    it('issues a prescription from a closed consultation, with its payment intent and audit event', async () => {
      const res = await request(app)
        .post(prescriptionUrl(closedConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send(prescriptionBody());

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({
        consultationId: closedConsultationId,
        patientProfileId,
        prescribingDoctorId: treatingDoctorProfileId,
        facilityProfileId: pharmacyId,
        amountStroops: '1500000',
        supersedesPrescriptionId: null,
        status: 'issued',
      });
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject(ITEM);
      expect(res.body.paymentIntent).toMatchObject({ prescriptionId: res.body.id, labOrderId: null, status: 'created', amount: '1500000' });

      const row = await prisma.prescription.findUniqueOrThrow({ where: { id: res.body.id }, include: { items: true } });
      expect(row.prescribingDoctorId).toBe(treatingDoctorProfileId);
      expect(row.items).toHaveLength(1);

      const events = await prisma.auditEvent.findMany({ where: { entityType: 'Prescription', entityId: res.body.id } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: 'prescription.issued', actorRole: 'doctor' });
    });

    it('issues a lab order from an open (not yet signed-off) consultation; notes are encrypted at rest', async () => {
      const res = await request(app)
        .post(labOrderUrl(openConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send(labOrderBody());

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({
        consultationId: openConsultationId,
        patientProfileId,
        orderingDoctorId: treatingDoctorProfileId,
        facilityProfileId: labId,
        testType: 'Full blood count',
        urgency: 'urgent',
        notes: 'Fasting sample.',
        supersedesLabOrderId: null,
      });
      expect(res.body.paymentIntent).toMatchObject({ labOrderId: res.body.id, prescriptionId: null, status: 'created', amount: '2500000' });

      const row = await prisma.labOrder.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.notes).not.toBeNull();
      expect(row.notes).not.toContain('Fasting sample.');

      const events = await prisma.auditEvent.findMany({ where: { entityType: 'LabOrder', entityId: res.body.id } });
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('lab_order.issued');
    });

    it('defaults a lab order to routine urgency', async () => {
      const { urgency: _urgency, notes: _notes, ...body } = labOrderBody();
      const res = await request(app)
        .post(labOrderUrl(closedConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.urgency).toBe('routine');
      expect(res.body.notes).toBeNull();
    });

    it('a prescription correction adds a superseding row and leaves the original untouched', async () => {
      const original = await request(app)
        .post(prescriptionUrl(closedConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send(prescriptionBody());
      expect(original.status).toBe(201);
      const before = await prisma.prescription.findUniqueOrThrow({ where: { id: original.body.id }, include: { items: true } });

      const correction = await request(app)
        .post(prescriptionUrl(closedConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send({ ...prescriptionBody(), supersedesPrescriptionId: original.body.id, items: [{ ...ITEM, dosage: '250 mg' }] });
      expect(correction.status, JSON.stringify(correction.body)).toBe(201);
      expect(correction.body.id).not.toBe(original.body.id);
      expect(correction.body.supersedesPrescriptionId).toBe(original.body.id);
      expect(correction.body.items[0].dosage).toBe('250 mg');

      const after = await prisma.prescription.findUniqueOrThrow({ where: { id: original.body.id }, include: { items: true } });
      expect(after).toEqual(before);

      // A second correction of the same original is refused — corrections chain, they don't fork.
      const again = await request(app)
        .post(prescriptionUrl(closedConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send({ ...prescriptionBody(), supersedesPrescriptionId: original.body.id });
      expect(again.status).toBe(409);
    });

    it('a lab order correction adds a superseding row and leaves the original untouched', async () => {
      const original = await request(app)
        .post(labOrderUrl(closedConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send(labOrderBody());
      expect(original.status).toBe(201);
      const before = await prisma.labOrder.findUniqueOrThrow({ where: { id: original.body.id } });

      const correction = await request(app)
        .post(labOrderUrl(closedConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send({ ...labOrderBody(), testType: 'Lipid panel', supersedesLabOrderId: original.body.id });
      expect(correction.status, JSON.stringify(correction.body)).toBe(201);
      expect(correction.body.supersedesLabOrderId).toBe(original.body.id);
      expect(correction.body.testType).toBe('Lipid panel');

      const after = await prisma.labOrder.findUniqueOrThrow({ where: { id: original.body.id } });
      expect(after).toEqual(before);

      const again = await request(app)
        .post(labOrderUrl(closedConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send({ ...labOrderBody(), supersedesLabOrderId: original.body.id });
      expect(again.status).toBe(409);
    });

    it('refuses to correct an order that belongs to a different consultation', async () => {
      const elsewhere = await request(app)
        .post(prescriptionUrl(openConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send(prescriptionBody());
      expect(elsewhere.status).toBe(201);
      const counts = await orderCounts();

      const res = await request(app)
        .post(prescriptionUrl(closedConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send({ ...prescriptionBody(), supersedesPrescriptionId: elsewhere.body.id });
      expect(res.status).toBe(409);
      expect(await orderCounts()).toEqual(counts);
    });
  });

  describe('access control: only the treating doctor', () => {
    const kinds = [
      { name: 'prescription', url: prescriptionUrl, body: () => prescriptionBody() },
      { name: 'lab order', url: labOrderUrl, body: () => labOrderBody() },
    ] as const;

    for (const kind of kinds) {
      it(`refuses another verified doctor issuing a ${kind.name} against someone else's consultation`, async () => {
        const counts = await orderCounts();
        const res = await request(app)
          .post(kind.url(closedConsultationId))
          .set('Authorization', `Bearer ${otherDoctorToken}`)
          .send(kind.body());
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(await orderCounts()).toEqual(counts);
      });

      it(`refuses the consultation's own patient issuing a ${kind.name}`, async () => {
        const counts = await orderCounts();
        const res = await request(app).post(kind.url(closedConsultationId)).set('Authorization', `Bearer ${patientToken}`).send(kind.body());
        expect(res.status).toBe(403);
        expect(await orderCounts()).toEqual(counts);
      });

      it(`refuses a facility and an admin issuing a ${kind.name}`, async () => {
        const counts = await orderCounts();
        for (const token of [facilityToken, adminToken]) {
          const res = await request(app).post(kind.url(closedConsultationId)).set('Authorization', `Bearer ${token}`).send(kind.body());
          expect(res.status).toBe(403);
        }
        expect(await orderCounts()).toEqual(counts);
      });

      it(`refuses an anonymous caller issuing a ${kind.name}`, async () => {
        const counts = await orderCounts();
        const res = await request(app).post(kind.url(closedConsultationId)).send(kind.body());
        expect(res.status).toBe(401);
        expect(await orderCounts()).toEqual(counts);
      });

      it(`refuses a doctor with an unverified email issuing a ${kind.name}`, async () => {
        const counts = await orderCounts();
        const res = await request(app).post(kind.url(closedConsultationId)).set('Authorization', `Bearer ${unverifiedEmailDoctorToken}`).send(kind.body());
        expect(res.status).toBe(403);
        expect(await orderCounts()).toEqual(counts);
      });

      it(`refuses the treating doctor issuing a ${kind.name} while their profile is not verified`, async () => {
        await prisma.doctorProfile.update({ where: { id: treatingDoctorProfileId }, data: { verificationStatus: 'pending' } });
        try {
          const counts = await orderCounts();
          const res = await request(app).post(kind.url(closedConsultationId)).set('Authorization', `Bearer ${treatingDoctorToken}`).send(kind.body());
          expect(res.status).toBe(403);
          expect(await orderCounts()).toEqual(counts);
        } finally {
          await prisma.doctorProfile.update({ where: { id: treatingDoctorProfileId }, data: { verificationStatus: 'verified' } });
        }
      });

      it(`gives another doctor 403, not the state, for a ${kind.name} on an invalid-state consultation`, async () => {
        const res = await request(app).post(kind.url(scheduledConsultationId)).set('Authorization', `Bearer ${otherDoctorToken}`).send(kind.body());
        expect(res.status).toBe(403);
      });
    }
  });

  describe('consultation state', () => {
    it('404s for an unknown consultation', async () => {
      const unknown = '00000000-0000-4000-8000-000000000000';
      const p = await request(app).post(prescriptionUrl(unknown)).set('Authorization', `Bearer ${treatingDoctorToken}`).send(prescriptionBody());
      const l = await request(app).post(labOrderUrl(unknown)).set('Authorization', `Bearer ${treatingDoctorToken}`).send(labOrderBody());
      expect([p.status, l.status]).toEqual([404, 404]);
    });

    for (const [label, id] of [['scheduled', () => scheduledConsultationId], ['cancelled', () => cancelledConsultationId]] as const) {
      it(`refuses both order types when the consultation's appointment is ${label} (409, nothing written)`, async () => {
        const counts = await orderCounts();
        const p = await request(app).post(prescriptionUrl(id())).set('Authorization', `Bearer ${treatingDoctorToken}`).send(prescriptionBody());
        const l = await request(app).post(labOrderUrl(id())).set('Authorization', `Bearer ${treatingDoctorToken}`).send(labOrderBody());
        expect(p.status, JSON.stringify(p.body)).toBe(409);
        expect(l.status, JSON.stringify(l.body)).toBe(409);
        expect(p.body.message.toLowerCase()).toContain('completed');
        expect(await orderCounts()).toEqual(counts);
      });
    }
  });

  describe('request validation', () => {
    it('rejects malformed bodies with 400 and writes nothing', async () => {
      const counts = await orderCounts();
      const bad = [
        { url: prescriptionUrl(closedConsultationId), body: { ...prescriptionBody(), items: [] } },
        { url: prescriptionUrl(closedConsultationId), body: { ...prescriptionBody(), catalogItemCode: 'AMOX-500' } },
        { url: prescriptionUrl(closedConsultationId), body: { facilityProfileId: pharmacyId, items: [ITEM] } },
        { url: labOrderUrl(closedConsultationId), body: { ...labOrderBody(), testType: '' } },
        { url: labOrderUrl(closedConsultationId), body: { ...labOrderBody(), urgency: 'stat' } },
        { url: labOrderUrl(closedConsultationId), body: { ...labOrderBody(), amountStroops: '0' } },
      ];
      for (const { url, body } of bad) {
        const res = await request(app).post(url).set('Authorization', `Bearer ${treatingDoctorToken}`).send(body);
        expect(res.status, `${url} ${JSON.stringify(body)} → ${JSON.stringify(res.body)}`).toBe(400);
      }
      expect(await orderCounts()).toEqual(counts);
    });

    it('rejects an unknown or wrong-type facility with 400 instead of failing on the foreign key', async () => {
      const counts = await orderCounts();
      const unknownFacility = '00000000-0000-4000-8000-000000000001';
      const cases = [
        { url: prescriptionUrl(closedConsultationId), body: { ...prescriptionBody(), facilityProfileId: unknownFacility } },
        { url: prescriptionUrl(closedConsultationId), body: { ...prescriptionBody(), facilityProfileId: labId } },
        { url: labOrderUrl(closedConsultationId), body: { ...labOrderBody(), facilityProfileId: unknownFacility } },
        { url: labOrderUrl(closedConsultationId), body: { ...labOrderBody(), facilityProfileId: pharmacyId } },
      ];
      for (const { url, body } of cases) {
        const res = await request(app).post(url).set('Authorization', `Bearer ${treatingDoctorToken}`).send(body);
        expect(res.status, `${url} → ${JSON.stringify(res.body)}`).toBe(400);
        expect(res.body.message).toMatch(/must be a (pharmacy|lab) facility/);
      }
      expect(await orderCounts()).toEqual(counts);
    });

    it('fails a catalog-priced order with 422 PRICE_ON_REQUEST when the facility has no published price', async () => {
      const counts = await orderCounts();
      const { amountStroops: _amount, ...body } = prescriptionBody();
      const res = await request(app)
        .post(prescriptionUrl(closedConsultationId))
        .set('Authorization', `Bearer ${treatingDoctorToken}`)
        .send({ ...body, catalogItemCode: 'AMOX-500' });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.code).toBe('PRICE_ON_REQUEST');
      expect(await orderCounts()).toEqual(counts);
    });
  });
});
