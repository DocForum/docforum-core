// Lab result attachment (Phase 5, issue #16 — docs/adr/0014) — integration
// coverage against a real Postgres and the full HTTP stack, with the
// in-process object store standing in for S3 (OBJECT_STORAGE_DRIVER=memory,
// set in vitest.config.mts).
//
// What this proves:
//   * only the facility the lab order was issued to can attach a result:
//     anonymous 401, patient/doctor 403, any other facility 404 — and a
//     refused attach stores nothing;
//   * the upload is validated: allowlisted Content-Type, the bytes must
//     match it, size-limited, non-empty;
//   * an accepted attach writes one LabResult row (opaque object key, never
//     returned), the object, and a `lab_result.attached` audit event — and
//     leaves the LabOrder itself untouched (hard rule 1);
//   * a result is attached once (409), never to a superseded order (409);
//   * reading the file back is limited to the patient, the ordering doctor
//     and the fulfilling facility (PRD §7). Everyone else — another patient,
//     doctor or facility, an admin — gets the same 404 as a missing order;
//     every successful read is access-logged and marked no-store.
//
// Self-contained embedded Postgres on its own port (5465), same pattern as
// the other files in this directory.
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
const PORT = 5465; // unique per integration file
const runId = Date.now();
const MAX_BYTES = 4096;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-lab-results-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_lab_results_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;
type Role = 'patient' | 'doctor' | 'facility' | 'admin';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('lab result body')]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

/** Collects a binary response body (supertest leaves application/pdf unparsed). */
function binary(res: request.Response, callback: (err: Error | null, body: Buffer) => void) {
  // In Node, superagent hands the parser the raw response stream.
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('lab result attachment (issue #16)', () => {
  let app: App;
  let prisma: Prisma;
  let objects: Map<string, unknown>;
  const tokens = {} as Record<'patient' | 'otherPatient' | 'doctor' | 'otherDoctor' | 'facility' | 'otherFacility' | 'admin', string>;
  let facilityProfileId: string;
  let patientProfileId: string;
  let labOrderId: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_lab_results_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    // Set before the dynamic imports: config and PrismaClient read these at
    // import time (same ordering note as the other files).
    process.env.DATABASE_URL = databaseUrl;
    process.env.LAB_RESULT_MAX_BYTES = String(MAX_BYTES);

    const { createApp } = await import('../../src/app.js');
    app = createApp();
    prisma = (await import('../../src/db/prisma-client.js')).prisma;
    const { signAccessToken } = await import('../../src/modules/auth/services/tokens.js');
    const storage = await import('../../src/utils/object-storage.js');
    objects = (storage.getObjectStorage() as InstanceType<typeof storage.MemoryObjectStorage>).objects;

    const user = async (tag: string, role: Role) => {
      const created = await prisma.user.create({
        data: { email: `lab-results-${tag}-${runId}@example.com`, passwordHash: 'unused', role, emailVerifiedAt: new Date() },
      });
      return { id: created.id, token: signAccessToken({ sub: created.id, role }) };
    };

    const patient = await user('patient', 'patient');
    tokens.patient = patient.token;
    patientProfileId = (await prisma.patientProfile.create({ data: { userId: patient.id, fullName: 'Lab Result Patient' } })).id;
    const otherPatient = await user('other-patient', 'patient');
    tokens.otherPatient = otherPatient.token;
    await prisma.patientProfile.create({ data: { userId: otherPatient.id, fullName: 'Unrelated Patient' } });

    const facility = await user('facility', 'facility');
    tokens.facility = facility.token;
    facilityProfileId = (await prisma.facilityProfile.create({ data: { userId: facility.id, name: 'Assigned Lab', type: 'lab' } })).id;
    const otherFacility = await user('other-facility', 'facility');
    tokens.otherFacility = otherFacility.token;
    await prisma.facilityProfile.create({ data: { userId: otherFacility.id, name: 'Other Lab', type: 'lab' } });

    const otherDoctor = await user('other-doctor', 'doctor');
    tokens.otherDoctor = otherDoctor.token;
    await prisma.doctorProfile.create({ data: { userId: otherDoctor.id, fullName: 'Unrelated Doctor', timeZone: 'UTC', verificationStatus: 'verified' } });

    tokens.admin = (await user('admin', 'admin')).token;

    const order = await createOrderFixture(prisma as never, {
      patientProfileId, facilityProfileId, kind: 'lab_order', amountStroops: 10_000_000n, tag: `lab-results-${runId}`,
    });
    labOrderId = order.id;
    const orderingDoctor = await prisma.doctorProfile.findUniqueOrThrow({ where: { id: order.doctorProfileId } });
    tokens.doctor = signAccessToken({ sub: orderingDoctor.userId, role: 'doctor' });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
  });

  const attach = (orderId: string, token: string | null, body: Buffer, contentType = 'application/pdf') => {
    const req = request(app).post(`/orders/lab-orders/${orderId}/result`).set('Content-Type', contentType);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  };

  const download = (orderId: string, token: string | null) => {
    const req = request(app).get(`/orders/lab-orders/${orderId}/result`).buffer(true).parse(binary);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  };

  describe('attaching', () => {
    it('refuses everyone but the assigned facility, and stores nothing when it does', async () => {
      expect((await attach(labOrderId, null, PDF)).status).toBe(401);
      expect((await attach(labOrderId, tokens.patient, PDF)).status).toBe(403);
      expect((await attach(labOrderId, tokens.doctor, PDF)).status).toBe(403);
      expect((await attach(labOrderId, tokens.admin, PDF)).status).toBe(403);
      // Another facility can't tell the order exists.
      const other = await attach(labOrderId, tokens.otherFacility, PDF);
      expect(other.status).toBe(404);
      expect(other.body.message).toBe('Lab order not found.');
      expect((await attach('00000000-0000-0000-0000-000000000000', tokens.facility, PDF)).status).toBe(404);

      expect(await prisma.labResult.count({ where: { labOrderId } })).toBe(0);
      expect(objects.size).toBe(0);
    });

    it('validates the file: type allowlist, content matching the type, size, non-empty', async () => {
      const wrongType = await attach(labOrderId, tokens.facility, Buffer.from('plain text'), 'text/plain');
      expect(wrongType.status).toBe(415);
      expect(wrongType.body.code).toBe('LAB_RESULT_UNSUPPORTED_TYPE');

      const mismatch = await attach(labOrderId, tokens.facility, PNG, 'application/pdf');
      expect(mismatch.status).toBe(415);
      expect(mismatch.body.code).toBe('LAB_RESULT_CONTENT_MISMATCH');

      const tooLarge = await attach(labOrderId, tokens.facility, Buffer.concat([PDF, Buffer.alloc(MAX_BYTES)]));
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.body.code).toBe('LAB_RESULT_TOO_LARGE');

      const empty = await attach(labOrderId, tokens.facility, Buffer.alloc(0));
      expect(empty.status).toBe(400);

      expect(await prisma.labResult.count({ where: { labOrderId } })).toBe(0);
      expect(objects.size).toBe(0);
    });

    it('attaches the result for the assigned facility without touching the order', async () => {
      const before = await prisma.labOrder.findUniqueOrThrow({ where: { id: labOrderId } });

      const res = await attach(labOrderId, tokens.facility, PDF);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        labOrderId, fulfillingFacilityId: facilityProfileId, contentType: 'application/pdf', byteSize: PDF.length,
      });
      // The storage key is internal: never in a response.
      expect(JSON.stringify(res.body)).not.toContain('lab-results/');

      const row = await prisma.labResult.findUniqueOrThrow({ where: { labOrderId } });
      expect(row.resultObjectKey).toMatch(/^lab-results\/[0-9a-f-]{36}$/);
      expect(row.resultObjectKey).not.toContain(labOrderId);
      expect(row.resultFileUrl).toBeNull();
      expect(objects.has(row.resultObjectKey!)).toBe(true);

      const audit = await prisma.auditEvent.findFirst({ where: { entityType: 'LabResult', entityId: row.id } });
      expect(audit).toMatchObject({ action: 'lab_result.attached', toState: 'attached' });

      expect(await prisma.labOrder.findUniqueOrThrow({ where: { id: labOrderId } })).toEqual(before);
    });

    it('attaches once: a second attach is 409 and stores nothing new', async () => {
      const objectCount = objects.size;
      const again = await attach(labOrderId, tokens.facility, PDF);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('LAB_RESULT_ALREADY_ATTACHED');
      expect(objects.size).toBe(objectCount);
    });

    it('refuses a superseded order — the result belongs on its correction', async () => {
      const original = await createOrderFixture(prisma as never, {
        patientProfileId, facilityProfileId, kind: 'lab_order', amountStroops: 10_000_000n, tag: `lab-results-sup-${runId}`,
      });
      const source = await prisma.labOrder.findUniqueOrThrow({ where: { id: original.id } });
      const correction = await prisma.labOrder.create({ data: {
        consultationId: source.consultationId, patientProfileId, orderingDoctorId: source.orderingDoctorId,
        facilityProfileId, amountStroops: source.amountStroops, testType: source.testType, supersedesLabOrderId: source.id,
      } });

      const res = await attach(original.id, tokens.facility, PDF);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LAB_ORDER_SUPERSEDED');
      expect((await attach(correction.id, tokens.facility, PDF)).status).toBe(201);
    });
  });

  describe('reading', () => {
    it.each(['patient', 'doctor', 'facility'] as const)('serves the file to the %s, uncached', async (who) => {
      const res = await download(labOrderId, tokens[who]);
      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="lab-result-${labOrderId}.pdf"`);
    });

    it.each(['otherPatient', 'otherDoctor', 'otherFacility', 'admin'] as const)(
      'gives the %s the same 404 as a missing order',
      async (who) => {
        const res = await download(labOrderId, tokens[who]);
        expect(res.status).toBe(404);
        expect(JSON.parse((res.body as Buffer).toString()).message).toBe('Lab order not found.');
      },
    );

    it('requires authentication', async () => {
      expect((await download(labOrderId, null)).status).toBe(401);
    });

    it('404s when no result has been attached yet', async () => {
      const pending = await createOrderFixture(prisma as never, {
        patientProfileId, facilityProfileId, kind: 'lab_order', amountStroops: 10_000_000n, tag: `lab-results-pending-${runId}`,
      });
      const res = await download(pending.id, tokens.patient);
      expect(res.status).toBe(404);
      expect(JSON.parse((res.body as Buffer).toString()).code).toBe('LAB_RESULT_NOT_FOUND');
    });

    it('access-logs every read against the patient', async () => {
      const result = await prisma.labResult.findUniqueOrThrow({ where: { labOrderId } });
      // recordAccess is fire-and-forget by design; give the insert a moment.
      let logged = 0;
      for (let attempt = 0; attempt < 20 && logged < 3; attempt += 1) {
        logged = await prisma.accessLog.count({ where: { entityType: 'LabResult', entityId: result.id, patientProfileId } });
        if (logged < 3) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // One per successful read above (patient, doctor, facility); refused
      // reads log nothing.
      expect(logged).toBe(3);
    });
  });
});
