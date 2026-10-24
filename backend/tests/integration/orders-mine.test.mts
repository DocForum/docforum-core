import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { encryptField } from '../../src/utils/field-encryption.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5452;
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-orders-mine-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
const previousEncryptionKey = process.env.FIELD_ENCRYPTION_KEY_V1;
const previousEncryptionVersion = process.env.FIELD_ENCRYPTION_ACTIVE_VERSION;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

describe('GET /orders/mine', () => {
  let app: App;
  let prisma: Prisma;
  let patientToken: string;
  let patientProfileId: string;
  let otherPatientProfileId: string;

  beforeAll(async () => {
    process.env.FIELD_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 7).toString('base64');
    process.env.FIELD_ENCRYPTION_ACTIVE_VERSION = 'v1';
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;
    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    const patient = await request(app).post('/auth/signup').send({
      role: 'patient', email: `orders-mine-${runId}@example.com`, password: 'longenough123', fullName: 'Orders Patient',
    });
    expect(patient.status).toBe(200);
    patientToken = patient.body.accessToken as string;
    patientProfileId = (await prisma.patientProfile.findUniqueOrThrow({ where: { userId: patient.body.user.id } })).id;

    const otherUser = await prisma.user.create({
      data: { email: `orders-mine-other-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
    });
    otherPatientProfileId = (await prisma.patientProfile.create({ data: { userId: otherUser.id, fullName: 'Other Patient' } })).id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousEncryptionKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY_V1;
    else process.env.FIELD_ENCRYPTION_KEY_V1 = previousEncryptionKey;
    if (previousEncryptionVersion === undefined) delete process.env.FIELD_ENCRYPTION_ACTIVE_VERSION;
    else process.env.FIELD_ENCRYPTION_ACTIVE_VERSION = previousEncryptionVersion;
  });

  it('returns only latest correction versions by default and exposes the full chain on request', async () => {
    const doctorUser = await prisma.user.create({
      data: { email: `orders-mine-doctor-${runId}@example.com`, passwordHash: 'unused', role: 'doctor' },
    });
    const doctor = await prisma.doctorProfile.create({ data: { userId: doctorUser.id, fullName: 'Orders Doctor' } });
    const facilityUser = await prisma.user.create({
      data: { email: `orders-mine-facility-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    const facility = await prisma.facilityProfile.create({ data: { userId: facilityUser.id, name: 'Orders Facility', type: 'pharmacy' } });
    const slot = await prisma.availabilitySlot.create({
      data: { doctorProfileId: doctor.id, startTime: new Date(Date.now() + 3_600_000), endTime: new Date(Date.now() + 5_400_000) },
    });
    const appointment = await prisma.appointment.create({ data: { patientProfileId, doctorProfileId: doctor.id, availabilitySlotId: slot.id } });
    const consultation = await prisma.consultation.create({ data: { appointmentId: appointment.id } });

    const oldPrescription = await prisma.prescription.create({
      data: {
        consultationId: consultation.id, patientProfileId, prescribingDoctorId: doctor.id,
        facilityProfileId: facility.id, amountStroops: 100n,
        items: { create: [{ drugName: 'Old medicine', dosage: '1 tablet', frequency: 'daily', duration: '5 days' }] },
      },
    });
    const currentPrescription = await prisma.prescription.create({
      data: {
        consultationId: consultation.id, patientProfileId, prescribingDoctorId: doctor.id,
        facilityProfileId: facility.id, amountStroops: 125n, supersedesPrescriptionId: oldPrescription.id,
        items: { create: [{ drugName: 'Corrected medicine', dosage: '2 tablets', frequency: 'daily', duration: '5 days' }] },
      },
    });
    const oldLabOrder = await prisma.labOrder.create({
      data: {
        consultationId: consultation.id, patientProfileId, orderingDoctorId: doctor.id,
        facilityProfileId: facility.id, amountStroops: 200n, testType: 'Old panel', notes: encryptField('old notes') ?? null,
      },
    });
    const currentLabOrder = await prisma.labOrder.create({
      data: {
        consultationId: consultation.id, patientProfileId, orderingDoctorId: doctor.id,
        facilityProfileId: facility.id, amountStroops: 250n, testType: 'Corrected panel',
        supersedesLabOrderId: oldLabOrder.id, notes: encryptField('current notes') ?? null,
      },
    });

    // A different patient's records must never be included in this response.
    const otherSlot = await prisma.availabilitySlot.create({
      data: { doctorProfileId: doctor.id, startTime: new Date(Date.now() + 7_200_000), endTime: new Date(Date.now() + 9_000_000) },
    });
    const otherAppointment = await prisma.appointment.create({
      data: { patientProfileId: otherPatientProfileId, doctorProfileId: doctor.id, availabilitySlotId: otherSlot.id },
    });
    const otherConsultation = await prisma.consultation.create({ data: { appointmentId: otherAppointment.id } });
    await prisma.prescription.create({
      data: {
        consultationId: otherConsultation.id, patientProfileId: otherPatientProfileId,
        prescribingDoctorId: doctor.id, facilityProfileId: facility.id, amountStroops: 10n,
        items: { create: [{ drugName: 'Other patient medicine', dosage: '1', frequency: 'daily', duration: '1 day' }] },
      },
    });

    const current = await request(app).get('/orders/mine').set('Authorization', `Bearer ${patientToken}`);
    expect(current.status).toBe(200);
    expect(current.body.prescriptions.map((row: { id: string }) => row.id)).toEqual([currentPrescription.id]);
    expect(current.body.labOrders.map((row: { id: string }) => row.id)).toEqual([currentLabOrder.id]);
    expect(current.body.prescriptions[0].amountStroops).toBe('125');
    expect(current.body.prescriptions[0].items[0].drugName).toBe('Corrected medicine');
    expect(current.body.labOrders[0].notes).toBe('current notes');

    const history = await request(app).get('/orders/mine?includeHistory=true').set('Authorization', `Bearer ${patientToken}`);
    expect(history.status).toBe(200);
    expect(history.body.prescriptions.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([oldPrescription.id, currentPrescription.id]));
    expect(history.body.labOrders.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([oldLabOrder.id, currentLabOrder.id]));
    expect(history.body.prescriptions).toHaveLength(2);
    expect(history.body.labOrders).toHaveLength(2);
  });
});
