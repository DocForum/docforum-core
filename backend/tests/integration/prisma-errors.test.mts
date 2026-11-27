// Issue #334: Prisma's real P2003/P2025 (and P2002) errors, raised by the
// driver adapter against a real Postgres — including from inside an
// interactive transaction — reach the client as 4xx with no schema detail.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5486;
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-prisma-errors-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_prisma_errors_test`;

// Anything that would identify a table, column, constraint or Prisma itself.
const LEAKS = /Specialty|DoctorSpecialty|doctorProfileId|specialtyId|fkey|_key|constraint|prisma|invocation|P20\d\d/i;

describe('Prisma error mapping against a real database', () => {
  let app: express.Express;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let doctorProfileId: string;
  let specialtyName: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_prisma_errors_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;
    prisma = (await import('../../src/db/prisma-client.js')).prisma;
    const { errorHandler } = await import('../../src/middleware/error-handler.js');

    const user = await prisma.user.create({
      data: { email: `prisma-errors-${runId}@example.com`, passwordHash: 'unused', role: 'doctor' },
    });
    doctorProfileId = (await prisma.doctorProfile.create({ data: { userId: user.id, fullName: 'Prisma Errors', timeZone: 'UTC' } })).id;
    specialtyName = `Existing ${runId}`;
    await prisma.specialty.create({ data: { name: specialtyName, slug: `existing-${runId}` } });

    // Real Prisma calls behind the app's real error handler: the same path a
    // route that forgot an explicit check would take.
    app = express();
    app.post('/p2025', async () => {
      await prisma.specialty.update({ where: { id: randomUUID() }, data: { isRetired: true } });
    });
    app.post('/p2003', async () => {
      await prisma.doctorSpecialty.create({ data: { doctorProfileId, specialtyId: randomUUID() } });
    });
    app.post('/p2003-in-transaction', async () => {
      await prisma.$transaction(async (tx) => {
        await tx.doctorSpecialty.create({ data: { doctorProfileId, specialtyId: randomUUID() } });
      });
    });
    app.post('/p2025-in-transaction', async () => {
      await prisma.$transaction(async (tx) => {
        await tx.specialty.delete({ where: { id: randomUUID() } });
      });
    });
    app.post('/p2002', async () => {
      await prisma.specialty.create({ data: { name: specialtyName, slug: `dup-${randomUUID()}` } });
    });
    app.use(errorHandler);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it.each([
    ['/p2025', 404, 'NOT_FOUND', 'Record not found.'],
    ['/p2025-in-transaction', 404, 'NOT_FOUND', 'Record not found.'],
    ['/p2003', 422, 'INVALID_REFERENCE', 'The request refers to a record that does not exist or is still in use.'],
    ['/p2003-in-transaction', 422, 'INVALID_REFERENCE', 'The request refers to a record that does not exist or is still in use.'],
    ['/p2002', 409, 'DUPLICATE_RECORD', 'A record with this value already exists.'],
  ])('%s answers %i with a coded generic message', async (route, status, code, message) => {
    const res = await request(app).post(route);
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ code, message });
    expect(res.text).not.toMatch(LEAKS);
  });

  it('wrote nothing for the failed foreign-key inserts', async () => {
    expect(await prisma.doctorSpecialty.count({ where: { doctorProfileId } })).toBe(0);
  });
});
