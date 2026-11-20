// Abnormal lab result escalation and doctor acknowledgement (Phase 4,
// issue #72, PRD §8.2.7) — integration coverage against a real Postgres and
// the full HTTP stack.
//
// What this proves:
//  - the facility's abnormality flag is stored on the result and only
//    abnormal/critical results open an acknowledgement task (and notify the
//    ordering doctor);
//  - only the ordering doctor can acknowledge, once; the audit trail records
//    it and a repeat is a 409;
//  - the doctor's unacknowledged list is owner-scoped, while an admin sees the
//    escalation queue;
//  - a missed job tick is visible: `overdue` is derived from the deadline, so
//    the admin queue shows an overdue result before `escalatedAt` is written;
//  - the escalation sweep is a conditional UPDATE: it escalates overdue
//    unacknowledged results and never an acknowledged one.
//
// Self-contained embedded Postgres on its own port (5471).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { createOrderFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5471; // unique per integration file
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-lab-escalation-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_lab_escalation_test`;

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('abnormal result body')]);

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

describe('abnormal lab result escalation (issue #72)', () => {
  let app: App;
  let prisma: Prisma;
  let acknowledgements: typeof import('../../src/modules/orders/services/lab-result-acknowledgements.js');
  const tokens = {} as Record<'patient' | 'facility' | 'admin' | 'otherDoctor', string>;
  let patientProfileId: string;
  let facilityProfileId: string;

  async function makeUser(tag: string, role: 'patient' | 'doctor' | 'facility' | 'admin') {
    return prisma.user.create({
      data: {
        email: `lab-escalation-${tag}-${runId}@example.com`,
        passwordHash: 'unused',
        role,
        emailVerifiedAt: new Date(),
      },
    });
  }

  async function createLabOrder() {
    return createOrderFixture(prisma as never, {
      patientProfileId,
      facilityProfileId,
      kind: 'lab_order',
      amountStroops: 1_000_000n,
      tag: `lab-escalation-${runId}-${Math.random().toString(36).slice(2)}`,
    });
  }

  async function orderDoctorToken(order: { doctorProfileId: string }) {
    const profile = await prisma.doctorProfile.findUniqueOrThrow({
      where: { id: order.doctorProfileId },
      select: { userId: true },
    });
    // Acknowledging is a verified-email mutation (issue #34); the order
    // fixture creates the doctor row without that timestamp.
    await prisma.user.update({ where: { id: profile.userId }, data: { emailVerifiedAt: new Date() } });
    const { signAccessToken } = await import('../../src/modules/auth/services/tokens.js');
    return signAccessToken({ sub: profile.userId, role: 'doctor' });
  }

  function attach(labOrderId: string, token: string, abnormality: string, body = PDF) {
    return request(app)
      .post(`/orders/lab-orders/${labOrderId}/result`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/pdf')
      .query({ abnormality })
      .send(body);
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_lab_escalation_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;
    process.env.LAB_RESULT_ESCALATION_HOURS = '1';

    const { createApp } = await import('../../src/app.js');
    app = createApp();
    prisma = (await import('../../src/db/prisma-client.js')).prisma;
    acknowledgements = await import('../../src/modules/orders/services/lab-result-acknowledgements.js');
    const { signAccessToken } = await import('../../src/modules/auth/services/tokens.js');

    const patient = await makeUser('patient', 'patient');
    patientProfileId = (
      await prisma.patientProfile.create({ data: { userId: patient.id, fullName: 'Escalation Patient' } })
    ).id;
    tokens.patient = signAccessToken({ sub: patient.id, role: 'patient' });

    const facility = await makeUser('facility', 'facility');
    facilityProfileId = (
      await prisma.facilityProfile.create({ data: { userId: facility.id, name: 'Escalation Lab', type: 'lab' } })
    ).id;
    tokens.facility = signAccessToken({ sub: facility.id, role: 'facility' });

    const admin = await makeUser('admin', 'admin');
    tokens.admin = signAccessToken({ sub: admin.id, role: 'admin' });

    const otherDoctor = await makeUser('other-doctor', 'doctor');
    await prisma.doctorProfile.create({
      data: {
        userId: otherDoctor.id,
        fullName: 'Other Doctor',
        timeZone: 'UTC',
        verificationStatus: 'verified',
      },
    });
    tokens.otherDoctor = signAccessToken({ sub: otherDoctor.id, role: 'doctor' });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores a normal result without opening an acknowledgement task', async () => {
    const order = await createLabOrder();
    const res = await attach(order.id, tokens.facility, 'normal');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ abnormality: 'normal', acknowledgement: null });
    expect(await prisma.labResultAcknowledgement.count({ where: { labResult: { labOrderId: order.id } } })).toBe(0);
  });

  it('opens an acknowledgement task, alerts the ordering doctor, and scopes the list', async () => {
    const order = await createLabOrder();
    const token = await orderDoctorToken(order);
    const res = await attach(order.id, tokens.facility, 'abnormal');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ abnormality: 'abnormal' });
    expect(res.body.acknowledgement.acknowledgedAt).toBeNull();

    const task = await prisma.labResultAcknowledgement.findUniqueOrThrow({
      where: { labResultId: res.body.id },
    });
    expect(task.severity).toBe('abnormal');
    expect(task.escalationDueAt.getTime()).toBeGreaterThan(Date.now());

    // The doctor's list contains the task; another doctor's does not.
    const mine = await request(app)
      .get('/lab-results/unacknowledged')
      .set('Authorization', `Bearer ${token}`);
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((item: { labResultId: string }) => item.labResultId)).toContain(res.body.id);

    const other = await request(app)
      .get('/lab-results/unacknowledged')
      .set('Authorization', `Bearer ${tokens.otherDoctor}`);
    expect(other.status).toBe(200);
    expect(other.body.items).toEqual([]);

    // Not yet overdue, so not in the admin escalation queue.
    const adminQueue = await request(app)
      .get('/lab-results/unacknowledged')
      .set('Authorization', `Bearer ${tokens.admin}`);
    expect(adminQueue.status).toBe(200);
    expect(adminQueue.body.items).toEqual([]);

    // The ordering doctor got an in-app notification (side effect after the
    // attach commits; poll briefly).
    const doctorUserId = (
      await prisma.doctorProfile.findUniqueOrThrow({ where: { id: order.doctorProfileId } })
    ).userId;
    let notification = await prisma.notification.findFirst({
      where: { userId: doctorUserId, type: 'lab_result_abnormal' },
    });
    for (let attempt = 0; attempt < 20 && !notification; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      notification = await prisma.notification.findFirst({
        where: { userId: doctorUserId, type: 'lab_result_abnormal' },
      });
    }
    expect(notification?.payload).toMatchObject({ labResultId: res.body.id, severity: 'abnormal' });
  });

  it('lets only the ordering doctor acknowledge, exactly once', async () => {
    const order = await createLabOrder();
    const token = await orderDoctorToken(order);
    const created = await attach(order.id, tokens.facility, 'critical');
    expect(created.status).toBe(201);

    const anonymous = await request(app).post(`/lab-results/${created.body.id}/acknowledge`);
    expect(anonymous.status).toBe(401);

    const wrongRole = await request(app)
      .post(`/lab-results/${created.body.id}/acknowledge`)
      .set('Authorization', `Bearer ${tokens.patient}`);
    expect(wrongRole.status).toBe(403);

    const wrongDoctor = await request(app)
      .post(`/lab-results/${created.body.id}/acknowledge`)
      .set('Authorization', `Bearer ${tokens.otherDoctor}`);
    expect(wrongDoctor.status).toBe(404);

    const acknowledged = await request(app)
      .post(`/lab-results/${created.body.id}/acknowledge`)
      .set('Authorization', `Bearer ${token}`);
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body.acknowledgedAt).toBeTruthy();
    expect(acknowledged.body.acknowledgedByDoctorId).toBe(order.doctorProfileId);

    const audit = await prisma.auditEvent.findFirst({
      where: { entityType: 'LabResult', entityId: created.body.id, action: 'lab_result.acknowledged' },
    });
    expect(audit).toMatchObject({ fromState: 'pending', toState: 'acknowledged' });

    const again = await request(app)
      .post(`/lab-results/${created.body.id}/acknowledge`)
      .set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(409);
  });

  it('escalates overdue results, never acknowledged ones, and shows overdue before the job runs', async () => {
    const order = await createLabOrder();
    const token = await orderDoctorToken(order);
    const created = await attach(order.id, tokens.facility, 'critical');
    expect(created.status).toBe(201);

    // Backdate the deadline to simulate a missed tick.
    await prisma.labResultAcknowledgement.update({
      where: { labResultId: created.body.id },
      data: { escalationDueAt: new Date(Date.now() - 60_000) },
    });

    // The admin queue sees it as overdue even though `escalatedAt` is unset.
    const adminQueue = await request(app)
      .get('/lab-results/unacknowledged')
      .set('Authorization', `Bearer ${tokens.admin}`);
    expect(adminQueue.status).toBe(200);
    expect(adminQueue.body.items).toHaveLength(1);
    expect(adminQueue.body.items[0]).toMatchObject({ labResultId: created.body.id, overdue: true, escalatedAt: null });

    const { escalated } = await acknowledgements.escalateOverdueResults();
    expect(escalated).toBe(1);

    const task = await prisma.labResultAcknowledgement.findUniqueOrThrow({
      where: { labResultId: created.body.id },
    });
    expect(task.escalatedAt).not.toBeNull();
    expect(
      await prisma.auditEvent.findFirst({
        where: { entityType: 'LabResult', entityId: created.body.id, action: 'lab_result.escalated' },
      }),
    ).not.toBeNull();

    // Acknowledged tasks are never escalated, even if their deadline passed.
    const ack = await request(app)
      .post(`/lab-results/${created.body.id}/acknowledge`)
      .set('Authorization', `Bearer ${token}`);
    expect(ack.status).toBe(200);
    await prisma.labResultAcknowledgement.update({
      where: { labResultId: created.body.id },
      data: { escalatedAt: null, escalationDueAt: new Date(Date.now() - 60_000) },
    });
    const secondRun = await acknowledgements.escalateOverdueResults();
    expect(secondRun.escalated).toBe(0);
    expect(
      (await prisma.labResultAcknowledgement.findUniqueOrThrow({ where: { labResultId: created.body.id } }))
        .escalatedAt,
    ).toBeNull();
  });
});
