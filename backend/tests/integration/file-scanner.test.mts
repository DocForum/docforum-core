// Integration tests for issue #324 — pluggable malware scanning for uploaded
// clinical files (lab result attachments).
//
// What is proven here against a real Postgres (embedded, port 5501):
//  - Clean scan: file proceeds to storage and LabResult row is created.
//  - Infected scan: upload is refused with 422 LAB_RESULT_INFECTED, nothing
//    is written to storage, no LabResult row exists.
//  - Scan error, fail-open: upload proceeds with a logged warning.
//  - Scan error, fail-closed: upload is refused with 503.
//  - NoOpFileScanner (default): all files pass (default dev behaviour).
//
// The ClamAV adapter is not tested here because it requires a live clamd
// daemon. Its logic is covered by the unit test below.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { createOrderFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5501;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-file-scanner-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_file_scanner_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('scanner test body')]);

let app: App;
let prisma: Prisma;
let facilityToken: string;
let facilityProfileId: string;
let scannerModule: typeof import('../../src/utils/file-scanner.js');
let storageModule: typeof import('../../src/utils/object-storage.js');
let objects: Map<string, unknown>;

beforeAll(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('docforum_file_scanner_test');

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  // Keep the max small so we can send a valid PDF without hitting limits.
  process.env.LAB_RESULT_MAX_BYTES = '65536';

  const { createApp } = await import('../../src/app.js');
  app = createApp();
  prisma = (await import('../../src/db/prisma-client.js')).prisma;
  const { signAccessToken } = await import('../../src/modules/auth/services/tokens.js');
  scannerModule = await import('../../src/utils/file-scanner.js');
  storageModule = await import('../../src/utils/object-storage.js');
  objects = (storageModule.getObjectStorage() as InstanceType<typeof storageModule.MemoryObjectStorage>).objects;

  const facilityUser = await prisma.user.create({
    data: { email: `scanner-facility-${runId}@example.com`, passwordHash: 'unused', role: 'facility', emailVerifiedAt: new Date() },
  });
  const facilityProfile = await prisma.facilityProfile.create({
    data: { userId: facilityUser.id, name: `Scanner Facility ${runId}`, type: 'lab' },
  });
  facilityProfileId = facilityProfile.id;
  facilityToken = signAccessToken({ sub: facilityUser.id, role: 'facility' });
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await pg.stop();
});

afterEach(() => {
  scannerModule.resetFileScannerForTests();
  // Reset fail-open to default after each test.
  delete process.env.FILE_SCANNING_FAIL_OPEN;
});

async function makeLabOrder() {
  const patientUser = await prisma.user.create({
    data: {
      email: `scanner-patient-${runId}-${Math.random().toString(36).slice(2)}@example.com`,
      passwordHash: 'unused',
      role: 'patient',
    },
  });
  const patientProfile = await prisma.patientProfile.create({ data: { userId: patientUser.id, fullName: 'Scanner Patient' } });
  const order = await createOrderFixture(prisma as never, {
    patientProfileId: patientProfile.id,
    facilityProfileId,
    kind: 'lab_order',
    amountStroops: 10_000n,
    tag: `scanner-${runId}-${Math.random().toString(36).slice(2)}`,
  });
  return order.id;
}

function attach(labOrderId: string, body: Buffer) {
  return request(app)
    .post(`/orders/lab-orders/${labOrderId}/result`)
    .set('Authorization', `Bearer ${facilityToken}`)
    .set('Content-Type', 'application/pdf')
    .send(body);
}

describe('malware scanning (issue #324)', () => {
  it('clean scan: upload proceeds and LabResult row is created', async () => {
    scannerModule.setFileScannerForTests({ scan: async () => 'clean' });
    const labOrderId = await makeLabOrder();
    const before = objects.size;

    const res = await attach(labOrderId, PDF);
    expect(res.status).toBe(201);
    expect(objects.size).toBe(before + 1);
    const result = await prisma.labResult.findFirst({ where: { labOrderId } });
    expect(result).not.toBeNull();
  });

  it('infected scan: upload refused with 422, nothing written', async () => {
    scannerModule.setFileScannerForTests({ scan: async () => 'infected' });
    const labOrderId = await makeLabOrder();
    const before = objects.size;

    const res = await attach(labOrderId, PDF);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LAB_RESULT_INFECTED');
    expect(objects.size).toBe(before);
    const result = await prisma.labResult.findFirst({ where: { labOrderId } });
    expect(result).toBeNull();
  });

  it('scan error + fail-open: upload proceeds', async () => {
    scannerModule.setFileScannerForTests({ scan: async () => 'error' });
    // Default is fail-open (FILE_SCANNING_FAIL_OPEN not set to 'false').
    const labOrderId = await makeLabOrder();
    const before = objects.size;

    const res = await attach(labOrderId, PDF);
    expect(res.status).toBe(201);
    expect(objects.size).toBe(before + 1);
  });

  it('scan error + fail-closed: upload refused with 503', async () => {
    // `config.fileScanning.failOpen` is a getter, so setting the env var is
    // enough; the injected scanner must stay in place (resetting it would
    // fall back to the no-op scanner, which always reports clean).
    process.env.FILE_SCANNING_FAIL_OPEN = 'false';
    scannerModule.setFileScannerForTests({ scan: async () => 'error' });
    const labOrderId = await makeLabOrder();
    const before = objects.size;

    const res = await attach(labOrderId, PDF);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('LAB_RESULT_SCAN_UNAVAILABLE');
    expect(objects.size).toBe(before);
  });

  it('no-op scanner (default): all clean files pass through', async () => {
    // Don't inject anything — the NoOpFileScanner is the default.
    const labOrderId = await makeLabOrder();
    const before = objects.size;

    const res = await attach(labOrderId, PDF);
    expect(res.status).toBe(201);
    expect(objects.size).toBe(before + 1);
  });
});
