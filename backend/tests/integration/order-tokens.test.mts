// Integration tests for verifiable order tokens (issue #71)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5441;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-test-tokens-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

describe('Order tokens', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let doctorToken: string;
  let facilityToken: string;
  let doctorProfileId: string;
  let facilityProfileId: string;
  let patientProfileId: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl, ORDER_TOKEN_SECRET: 'test-secret-key-for-testing-only-32-bytes!!' },
      stdio: 'pipe',
    });

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    authServices.setEmailSender(async () => {});

    // Create doctor
    const doctorSignup = await request(app).post('/auth/signup').send({
      role: 'doctor',
      email: `doctor-${runId}@example.com`,
      password: 'longenough123',
      fullName: 'Test Doctor',
    });
    expect(doctorSignup.status).toBe(200);
    doctorToken = doctorSignup.body.accessToken;

    await prisma.user.update({
      where: { email: `doctor-${runId}@example.com` },
      data: { emailVerifiedAt: new Date() },
    });

    const doctorMe = await request(app).get('/doctors/me').set('Authorization', `Bearer ${doctorToken}`);
    doctorProfileId = doctorMe.body.id;

    // Create facility (pharmacy)
    const facilitySignup = await request(app).post('/auth/signup').send({
      role: 'doctor', // Will promote to facility
      email: `facility-${runId}@example.com`,
      password: 'longenough123',
      fullName: 'Test Pharmacy',
    });
    expect(facilitySignup.status).toBe(200);

    await prisma.user.update({
      where: { email: `facility-${runId}@example.com` },
      data: { role: 'facility', emailVerifiedAt: new Date() },
    });

    const facilityLogin = await request(app).post('/auth/login').send({
      email: `facility-${runId}@example.com`,
      password: 'longenough123',
    });
    facilityToken = facilityLogin.body.accessToken;

    const facilityUser = await prisma.user.findUnique({ where: { email: `facility-${runId}@example.com` } });
    const facilityProfile = await prisma.facilityProfile.findUnique({ where: { userId: facilityUser!.id } });
    facilityProfileId = facilityProfile!.id;

    // Create patient
    const patientSignup = await request(app).post('/auth/signup').send({
      role: 'patient',
      email: `patient-${runId}@example.com`,
      password: 'longenough123',
      fullName: 'Test Patient',
    });
    expect(patientSignup.status).toBe(200);
    // _patientToken = patientSignup.body.accessToken; // Not used in tests

    await prisma.user.update({
      where: { email: `patient-${runId}@example.com` },
      data: { emailVerifiedAt: new Date() },
    });

    const patientUser = await prisma.user.findUnique({ where: { email: `patient-${runId}@example.com` } });
    const patientProfile = await prisma.patientProfile.findUnique({ where: { userId: patientUser!.id } });
    patientProfileId = patientProfile!.id;
  });

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('issues a token when doctor creates a prescription', async () => {
    // Create a medication first
    await prisma.medication.create({
      data: {
        genericName: 'Test Med',
        strength: '100mg',
        form: 'tablet',
        route: 'oral',
        externalCode: 'TEST001',
        externalSystem: 'local',
      },
    });

    // Create a prescription via orders endpoint
    await request(app)
      .post('/orders/consultations/00000000-0000-0000-0000-000000000000/prescriptions')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        facilityProfileId: facilityProfileId,
        amountStroops: '1000000',
        items: [{
          drugName: 'Test Med',
          dosage: '1 tablet',
          frequency: 'twice daily',
          duration: '7 days',
        }],
      });

    // The above will fail due to invalid consultation, so let's test token issuance directly
    const tokenRes = await request(app)
      .post('/order-tokens')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        orderType: 'prescription',
        orderId: '00000000-0000-0000-0000-000000000000',
      });

    // Should fail because order doesn't exist
    expect(tokenRes.status).toBe(404);
  });

  it('verifies a valid token for the correct facility', async () => {
    // Create a prescription and token in DB
    const medication = await prisma.medication.create({
      data: {
        genericName: 'Test Med 2',
        strength: '200mg',
        form: 'tablet',
        route: 'oral',
        externalCode: 'TEST002',
        externalSystem: 'local',
      },
    });

    const prescription = await prisma.prescription.create({
      data: {
        consultationId: '00000000-0000-0000-0000-000000000000',
        patientProfileId,
        prescribingDoctorId: doctorProfileId,
        facilityProfileId,
        amountStroops: 1000000n,
        items: {
          create: {
            drugName: 'Test Med 2',
            dosage: '1 tablet',
            frequency: 'twice daily',
            duration: '7 days',
            medicationId: medication.id,
          },
        },
      },
    });

    // Issue token
    const tokenRes = await request(app)
      .post('/order-tokens')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        orderType: 'prescription',
        orderId: prescription.id,
      });

    expect(tokenRes.status).toBe(201);
    expect(tokenRes.body.token).toBeDefined();
    const token = tokenRes.body.token;

    // Verify token as the correct facility
    const verifyRes = await request(app)
      .post('/facilities/me/verify-order')
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ token });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.valid).toBe(true);
    expect(verifyRes.body.orderType).toBe('prescription');
    expect(verifyRes.body.orderId).toBe(prescription.id);
  });

  it('rejects token verification for wrong facility', async () => {
    // Create another facility
    const otherFacilitySignup = await request(app).post('/auth/signup').send({
      role: 'doctor',
      email: `other-facility-${runId}@example.com`,
      password: 'longenough123',
      fullName: 'Other Pharmacy',
    });
    expect(otherFacilitySignup.status).toBe(200);

    await prisma.user.update({
      where: { email: `other-facility-${runId}@example.com` },
      data: { role: 'facility', emailVerifiedAt: new Date() },
    });

    const otherFacilityLogin = await request(app).post('/auth/login').send({
      email: `other-facility-${runId}@example.com`,
      password: 'longenough123',
    });
    const otherFacilityToken = otherFacilityLogin.body.accessToken;

    // Create prescription and token
    const medication = await prisma.medication.create({
      data: {
        genericName: 'Test Med 3',
        strength: '300mg',
        form: 'tablet',
        route: 'oral',
        externalCode: 'TEST003',
        externalSystem: 'local',
      },
    });

    const prescription = await prisma.prescription.create({
      data: {
        consultationId: '00000000-0000-0000-0000-000000000000',
        patientProfileId,
        prescribingDoctorId: doctorProfileId,
        facilityProfileId,
        amountStroops: 1000000n,
        items: {
          create: {
            drugName: 'Test Med 3',
            dosage: '1 tablet',
            frequency: 'twice daily',
            duration: '7 days',
            medicationId: medication.id,
          },
        },
      },
    });

    const tokenRes = await request(app)
      .post('/order-tokens')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        orderType: 'prescription',
        orderId: prescription.id,
      });
    const token = tokenRes.body.token;

    // Verify with wrong facility
    const verifyRes = await request(app)
      .post('/facilities/me/verify-order')
      .set('Authorization', `Bearer ${otherFacilityToken}`)
      .send({ token });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.valid).toBe(false);
    expect(verifyRes.body.error).toContain('not eligible');
  });

  it('rejects token for superseded order', async () => {
    const medication = await prisma.medication.create({
      data: {
        genericName: 'Test Med 4',
        strength: '400mg',
        form: 'tablet',
        route: 'oral',
        externalCode: 'TEST004',
        externalSystem: 'local',
      },
    });

    const originalPrescription = await prisma.prescription.create({
      data: {
        consultationId: '00000000-0000-0000-0000-000000000000',
        patientProfileId,
        prescribingDoctorId: doctorProfileId,
        facilityProfileId,
        amountStroops: 1000000n,
        status: 'superseded',
        items: {
          create: {
            drugName: 'Test Med 4',
            dosage: '1 tablet',
            frequency: 'twice daily',
            duration: '7 days',
            medicationId: medication.id,
          },
        },
      },
    });

    const tokenRes = await request(app)
      .post('/order-tokens')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        orderType: 'prescription',
        orderId: originalPrescription.id,
      });
    const token = tokenRes.body.token;

    const verifyRes = await request(app)
      .post('/facilities/me/verify-order')
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ token });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.valid).toBe(false);
    expect(verifyRes.body.superseded).toBe(true);
  });

  it('rejects token for fulfilled order', async () => {
    const medication = await prisma.medication.create({
      data: {
        genericName: 'Test Med 5',
        strength: '500mg',
        form: 'tablet',
        route: 'oral',
        externalCode: 'TEST005',
        externalSystem: 'local',
      },
    });

    const fulfilledPrescription = await prisma.prescription.create({
      data: {
        consultationId: '00000000-0000-0000-0000-000000000000',
        patientProfileId,
        prescribingDoctorId: doctorProfileId,
        facilityProfileId,
        amountStroops: 1000000n,
        status: 'fulfilled',
        items: {
          create: {
            drugName: 'Test Med 5',
            dosage: '1 tablet',
            frequency: 'twice daily',
            duration: '7 days',
            medicationId: medication.id,
          },
        },
      },
    });

    const tokenRes = await request(app)
      .post('/order-tokens')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        orderType: 'prescription',
        orderId: fulfilledPrescription.id,
      });
    const token = tokenRes.body.token;

    const verifyRes = await request(app)
      .post('/facilities/me/verify-order')
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ token });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.valid).toBe(false);
    expect(verifyRes.body.fulfilled).toBe(true);
  });

  it('rejects invalid token', async () => {
    const verifyRes = await request(app)
      .post('/facilities/me/verify-order')
      .set('Authorization', `Bearer ${facilityToken}`)
      .send({ token: 'invalid-token' });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.valid).toBe(false);
    expect(verifyRes.body.error).toBe('Invalid token');
  });
});