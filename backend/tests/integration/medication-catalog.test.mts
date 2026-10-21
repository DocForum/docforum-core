// Integration tests for medication catalog (issue #69)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5439; // Different port to avoid conflicts
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-test-meds-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

describe('Medication catalog', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let adminToken: string;

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

    authServices.setEmailSender(async () => {
      // Capture verification tokens for testing
    });

    // Create admin user
    const adminSignup = await request(app).post('/auth/signup').send({
      role: 'doctor', // We'll use doctor role and promote to admin in DB
      email: `admin-${runId}@example.com`,
      password: 'longenough123',
      fullName: 'Test Admin',
    });
    expect(adminSignup.status).toBe(200);

    // Promote to admin in DB
    await prisma.user.update({
      where: { email: `admin-${runId}@example.com` },
      data: { role: 'admin' },
    });

    // Login as admin
    const adminLogin = await request(app).post('/auth/login').send({
      email: `admin-${runId}@example.com`,
      password: 'longenough123',
    });
    adminToken = adminLogin.body.accessToken;

    // Create doctor
    const doctorSignup = await request(app).post('/auth/signup').send({
      role: 'doctor',
      email: `doctor-${runId}@example.com`,
      password: 'longenough123',
      fullName: 'Test Doctor',
    });
    expect(doctorSignup.status).toBe(200);
    // doctorToken = doctorSignup.body.accessToken; // Not used in tests

    // Verify doctor email
    await prisma.user.update({
      where: { email: `doctor-${runId}@example.com` },
      data: { emailVerifiedAt: new Date() },
    });
  });

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('allows admin to create medications', async () => {
    const res = await request(app)
      .post('/admin/medications')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        genericName: 'Paracetamol',
        strength: '500mg',
        form: 'tablet',
        route: 'oral',
        externalCode: '161', // RxNorm CUI for Acetaminophen
        externalSystem: 'rxnorm',
      });

    expect(res.status).toBe(201);
    expect(res.body.genericName).toBe('Paracetamol');
    expect(res.body.strength).toBe('500mg');
    expect(res.body.externalCode).toBe('161');
  });

  it('prevents duplicate external codes', async () => {
    const res = await request(app)
      .post('/admin/medications')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        genericName: 'Acetaminophen',
        strength: '500mg',
        form: 'tablet',
        route: 'oral',
        externalCode: '161', // Same as above
        externalSystem: 'rxnorm',
      });

    expect(res.status).toBe(409);
  });

  it('allows public autocomplete search', async () => {
    const res = await request(app)
      .get('/medications?q=paracet');

    expect(res.status).toBe(200);
    expect(res.body.medications.length).toBeGreaterThan(0);
    expect(res.body.medications[0].genericName).toBe('Paracetamol');
    expect(res.body.medications[0].displayName).toContain('Paracetamol');
  });

  it('returns empty for short queries', async () => {
    const res = await request(app)
      .get('/medications?q=p');

    expect(res.status).toBe(200);
    expect(res.body.medications).toHaveLength(0);
  });

  it('lists medications with pagination', async () => {
    const res = await request(app)
      .get('/admin/medications')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.medications.length).toBeGreaterThan(0);
    expect(res.body.nextCursor).toBeDefined();
  });
});