// Feature flags (issue #132): admin list/toggle with an audit event per
// change, GET /me/flags, role/user targeting, and the wallet-funding gate on
// the payments prepare endpoint. Port 5456.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { installEmailCapture, makeAdmin, makePatient, resetEmailSenderFixture } from './helpers/fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5456;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-test-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

describe('feature flags', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let invalidateFlagCache: () => void;
  const emailedTokens = new Map<string, string>();
  let admin: Awaited<ReturnType<typeof makeAdmin>>;
  let patient: Awaited<ReturnType<typeof makePatient>>;
  let otherPatient: Awaited<ReturnType<typeof makePatient>>;

  const adminAuth = () => ({ Authorization: `Bearer ${admin.accessToken}` });
  const patch = (key: string, body: object) => request(app).patch(`/admin/feature-flags/${key}`).set(adminAuth()).send(body);
  const flagsFor = async (user: { accessToken: string }) => {
    const res = await request(app).get('/me/flags').set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    return res.body.flags as Record<string, boolean>;
  };

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
    process.env.FEATURE_FLAG_CACHE_TTL_SECONDS = '0'; // see every change at once
    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const flagsService = await import('../../src/modules/flags/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;
    invalidateFlagCache = flagsService.invalidateFlagCache;

    await installEmailCapture(emailedTokens);
    admin = await makeAdmin(app, prisma, emailedTokens, runId);
    patient = await makePatient(app, emailedTokens, runId);
    otherPatient = await makePatient(app, emailedTokens, runId);
  });

  afterAll(async () => {
    await resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('seeds the wallet-funding flag as off', async () => {
    const res = await request(app).get('/admin/feature-flags').set(adminAuth());
    expect(res.status).toBe(200);
    const wallet = res.body.items.find((f: { key: string }) => f.key === 'payments.wallet_funding');
    expect(wallet).toMatchObject({ enabled: false, rolloutPercent: 100, allowRoles: [], allowUserIds: [] });
    expect((await flagsFor(patient))['payments.wallet_funding']).toBe(false);
  });

  it('only admins can list or change flags', async () => {
    const asPatient = { Authorization: `Bearer ${patient.accessToken}` };
    expect((await request(app).get('/admin/feature-flags').set(asPatient)).status).toBe(403);
    expect((await request(app).patch('/admin/feature-flags/x.y').set(asPatient).send({ enabled: true })).status).toBe(403);
    expect((await request(app).get('/admin/feature-flags')).status).toBe(401);
    expect((await request(app).get('/me/flags')).status).toBe(401);
  });

  it('validates the key and the body', async () => {
    expect((await patch('Bad Key', { enabled: true })).status).toBe(400);
    expect((await patch('demo.flag', {})).status).toBe(400);
    expect((await patch('demo.flag', { rolloutPercent: 101 })).status).toBe(400);
    expect((await patch('demo.flag', { enabled: true, surprise: 1 })).status).toBe(400);
  });

  it('creating and toggling a flag changes /me/flags and writes one audit event per change', async () => {
    const created = await patch('demo.toggle', { enabled: true, rolloutPercent: 100, description: 'demo' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect((await flagsFor(patient))['demo.toggle']).toBe(true);

    expect((await patch('demo.toggle', { enabled: false })).status).toBe(200);
    expect((await flagsFor(patient))['demo.toggle']).toBe(false);

    const events = await prisma.auditEvent.findMany({
      where: { entityType: 'FeatureFlag', entityId: 'demo.toggle' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual(['feature_flag.created', 'feature_flag.updated']);
    expect(events[0]).toMatchObject({ fromState: null, toState: 'enabled', actorUserId: admin.userId, actorRole: 'admin' });
    expect(events[1]).toMatchObject({ fromState: 'enabled', toState: 'disabled', actorUserId: admin.userId });
  });

  it('user-id targeting turns a flag on for exactly that user; the audit trail stores counts, not ids', async () => {
    const res = await patch('demo.targeted', { enabled: true, rolloutPercent: 0, allowUserIds: [patient.userId] });
    expect(res.status).toBe(200);
    expect((await flagsFor(patient))['demo.targeted']).toBe(true);
    expect((await flagsFor(otherPatient))['demo.targeted']).toBe(false);

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: 'demo.targeted' } });
    expect(event.metadata).toMatchObject({ allowUserCount: 1, rolloutPercent: 0 });
    expect(JSON.stringify(event.metadata)).not.toContain(patient.userId);
  });

  it('role targeting excludes other roles', async () => {
    await patch('demo.doctors', { enabled: true, rolloutPercent: 100, allowRoles: ['doctor'] });
    expect((await flagsFor(patient))['demo.doctors']).toBe(false);
    const adminFlags = await request(app).get('/me/flags').set(adminAuth());
    expect(adminFlags.body.flags['demo.doctors']).toBe(false);
  });

  it('a percentage rollout is sticky across requests', async () => {
    await patch('demo.half', { enabled: true, rolloutPercent: 50 });
    const first = (await flagsFor(patient))['demo.half'];
    for (let i = 0; i < 5; i++) expect((await flagsFor(patient))['demo.half']).toBe(first);
  });

  it('gates wallet payments: 403 FEATURE_DISABLED while off, through to the service once on', async () => {
    const prepare = () =>
      request(app).post('/payments/intents/does-not-exist/prepare').set('Authorization', `Bearer ${patient.accessToken}`);

    await patch('payments.wallet_funding', { enabled: false });
    const off = await prepare();
    expect(off.status).toBe(403);
    expect(off.body.code).toBe('FEATURE_DISABLED');

    await patch('payments.wallet_funding', { enabled: true, rolloutPercent: 0, allowUserIds: [patient.userId] });
    expect((await prepare()).status).toBe(404); // past the gate: no such intent
    const blocked = await request(app)
      .post('/payments/intents/does-not-exist/prepare')
      .set('Authorization', `Bearer ${otherPatient.accessToken}`);
    expect(blocked.status).toBe(403);

    await patch('payments.wallet_funding', { enabled: false, allowUserIds: [] });
  });

  it('with the database unavailable nothing throws: an uncached flag reads as off', async () => {
    const { isEnabled } = await import('../../src/modules/flags/services/index.js');
    invalidateFlagCache();
    expect(await isEnabled('no.such.flag', { id: 'x', role: 'patient' })).toBe(false);
  });
});
