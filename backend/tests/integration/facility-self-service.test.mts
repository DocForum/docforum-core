// Facility self-service profile (issue #319): GET /facilities/me with an
// ETag, PATCH /facilities/me with If-Match, coordinate validation and the
// audit trail. Port 5495.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5495;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-test-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

describe('facility self-service profile (issue #319)', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let facilityToken: string;
  let facilityId: string;
  let facilityUserId: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;
    app = (await import('../../src/app.js')).createApp();
    prisma = (await import('../../src/db/prisma-client.js')).prisma;

    const bcryptjs = await import('bcryptjs');
    const user = await prisma.user.create({
      data: {
        email: `facility-me-${runId}@example.com`,
        passwordHash: await bcryptjs.hash('longenough123', 4),
        role: 'facility',
        emailVerifiedAt: new Date(),
      },
    });
    facilityUserId = user.id;
    facilityId = (
      await prisma.facilityProfile.create({
        data: { userId: user.id, name: 'Old Name Pharmacy', type: 'pharmacy', address: '1 Old Road', latitude: 6.5, longitude: 3.3 },
      })
    ).id;
    const login = await request(app).post('/auth/login').send({ email: user.email, password: 'longenough123' });
    expect(login.status).toBe(200);
    facilityToken = login.body.accessToken as string;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const read = () => request(app).get('/facilities/me').set('Authorization', `Bearer ${facilityToken}`);
  const patch = (body: unknown, ifMatch?: string) => {
    const req = request(app).patch('/facilities/me').set('Authorization', `Bearer ${facilityToken}`);
    if (ifMatch !== undefined) req.set('If-Match', ifMatch);
    return req.send(body as object);
  };

  it('returns the own profile with a version ETag', async () => {
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: facilityId, name: 'Old Name Pharmacy', address: '1 Old Road', type: 'pharmacy' });
    expect(res.headers.etag).toBe(`"${res.body.version}"`);
  });

  it('updates name, address and coordinates together and audits the change', async () => {
    const before = await read();
    const res = await patch({ name: 'New Name Pharmacy', address: '2 New Street', latitude: 9.05, longitude: 7.49 }, before.headers.etag);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'New Name Pharmacy', address: '2 New Street', latitude: 9.05, longitude: 7.49, type: 'pharmacy' });
    expect(res.body.version).toBe(before.body.version + 1);
    expect(res.headers.etag).toBe(`"${before.body.version + 1}"`);

    const events = await prisma.auditEvent.findMany({
      where: { entityType: 'FacilityProfile', entityId: facilityId, action: 'facility.profile_updated' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorUserId: facilityUserId, fromState: String(before.body.version) });
    expect(events[0].metadata).toMatchObject({ fieldsChanged: 'name,address,latitude,longitude' });
  });

  it('requires If-Match (428), rejects a malformed one (400) and a stale one (412)', async () => {
    const current = await read();
    expect((await patch({ name: 'No Precondition' })).status).toBe(428);
    expect((await patch({ name: 'Bad Precondition' }, 'W/"1"')).status).toBe(400);

    const stale = `"${current.body.version - 1 > 0 ? current.body.version - 1 : current.body.version + 5}"`;
    const conflict = await patch({ name: 'Lost Update' }, stale);
    expect(conflict.status).toBe(412);
    expect(conflict.body.code).toBe('VERSION_CONFLICT');

    // Two writers with the same ETag: exactly one wins.
    const [a, b] = await Promise.all([
      patch({ name: 'Writer A' }, current.headers.etag),
      patch({ name: 'Writer B' }, current.headers.etag),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 412]);
    expect((await read()).body.version).toBe(current.body.version + 1);
  });

  it('validates the body: coordinates both-or-neither and in range, no type change, not empty', async () => {
    const { headers } = await read();
    const etag = headers.etag as string;
    const bad: unknown[] = [
      {},
      { latitude: 10 },
      { longitude: 10 },
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: -181 },
      { latitude: '6.5', longitude: '3.3' },
      { type: 'lab' },
      { name: '' },
      { userId: 'someone-else' },
    ];
    for (const body of bad) {
      const res = await patch(body, etag);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // None of those wrote anything.
    expect((await read()).headers.etag).toBe(etag);
    expect((await prisma.facilityProfile.findUniqueOrThrow({ where: { id: facilityId } })).type).toBe('pharmacy');
  });

  it('is facility-only', async () => {
    const patient = await request(app)
      .post('/auth/signup')
      .send({ role: 'patient', email: `patient-me-${runId}@example.com`, password: 'longenough123', fullName: 'Patient Me' });
    const token = patient.body.accessToken as string;
    expect((await request(app).get('/facilities/me').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    expect((await request(app).patch('/facilities/me').set('Authorization', `Bearer ${token}`).set('If-Match', '"1"').send({ name: 'x' })).status).toBe(403);
    expect((await request(app).get('/facilities/me')).status).toBe(401);
  });
});
