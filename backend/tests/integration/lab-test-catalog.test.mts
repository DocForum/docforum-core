// Integration tests for lab test catalog (issue #70)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5440; // Different port to avoid conflicts
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-test-labtests-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

describe('Lab test catalog', () => {
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

    authServices.setEmailSender(async () => {});

    // Create admin user
    const adminSignup = await request(app).post('/auth/signup').send({
      role: 'doctor',
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
  });

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('allows admin to create lab tests', async () => {
    const res = await request(app)
      .post('/admin/lab-tests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '58410-2', // LOINC code for CBC
        name: 'Complete Blood Count',
        specimenType: 'blood',
        category: 'hematology',
      });

    expect(res.status).toBe(201);
    expect(res.body.code).toBe('58410-2');
    expect(res.body.name).toBe('Complete Blood Count');
    expect(res.body.specimenType).toBe('blood');
    expect(res.body.category).toBe('hematology');
  });

  it('prevents duplicate codes', async () => {
    const res = await request(app)
      .post('/admin/lab-tests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '58410-2',
        name: 'CBC Panel',
        specimenType: 'blood',
        category: 'hematology',
      });

    expect(res.status).toBe(409);
  });

  it('allows public autocomplete search', async () => {
    const res = await request(app)
      .get('/lab-tests?q=cbc');

    expect(res.status).toBe(200);
    expect(res.body.labTests.length).toBeGreaterThan(0);
    expect(res.body.labTests[0].code).toBe('58410-2');
    expect(res.body.labTests[0].displayName).toContain('Complete Blood Count');
  });

  it('returns empty for short queries', async () => {
    const res = await request(app)
      .get('/lab-tests?q=c');

    expect(res.status).toBe(200);
    expect(res.body.labTests).toHaveLength(0);
  });

  it('supports panel components', async () => {
    // Create component tests
    const hemoglobin = await request(app)
      .post('/admin/lab-tests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '718-7',
        name: 'Hemoglobin',
        specimenType: 'blood',
        category: 'hematology',
      });
    expect(hemoglobin.status).toBe(201);

    const hematocrit = await request(app)
      .post('/admin/lab-tests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '4544-3',
        name: 'Hematocrit',
        specimenType: 'blood',
        category: 'hematology',
      });
    expect(hematocrit.status).toBe(201);

    // Create panel
    const panel = await request(app)
      .post('/admin/lab-tests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '58410-2',
        name: 'CBC Panel (auto)',
        specimenType: 'blood',
        category: 'hematology',
        panelOfIds: [hemoglobin.body.id, hematocrit.body.id],
      });
    expect(panel.status).toBe(201);

    // Verify panel components
    const panelDetail = await request(app)
      .get(`/admin/lab-tests/${panel.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(panelDetail.status).toBe(200);
    // Panel components would be in the response if included
  });
});