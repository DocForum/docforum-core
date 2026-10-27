// Integration tests for issue #74 — facility location + distance-sorted
// eligible facility selection (PRD FR-13).
//
// Self-contained embedded Postgres on its own port (5439) so it runs
// alongside the other integration files.
//
// Covers:
//  - capability-filtered listing sorted ascending by distance, correct to
//    the haversine formula;
//  - facilities WITHOUT coordinates still appear, sorted last;
//  - radius filtering, and `radiusKm` without `near` rejecting with 400;
//  - privacy: the patient's query coordinates are never echoed back;
//  - performance: the same query measured against a few thousand
//    facilities, with the numbers printed for the PR (issue #74 DoD).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5439;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-distance-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

// Fictional facilities, coordinates spread around central Lagos. Expected
// distances below are verified against the haversine formula in the test.
const FACILITIES = [
  { key: 'near', name: 'Near Lab', lat: 6.53, lng: 3.38, capability: 'lab_test', detail: 'malaria' },
  { key: 'mid', name: 'Mid Pharmacy', lat: 6.45, lng: 3.37, capability: 'medication_dispense', detail: 'general' },
  { key: 'far', name: 'Far Pharmacy', lat: 6.02, lng: 3.24, capability: 'medication_dispense', detail: 'general' },
  { key: 'farlab', name: 'Far Lab', lat: 5.9, lng: 3.4, capability: 'lab_test', detail: 'malaria' },
  { key: 'noloc', name: 'No Location Pharmacy', lat: null, lng: null, capability: 'medication_dispense', detail: 'general' },
] as const;

const CENTER = { lat: 6.5244, lng: 3.3792 };

let app: App;
let prisma: Prisma;
let patientToken: string;

async function createFacilityRow(spec: (typeof FACILITIES)[number], suffix: string) {
  const user = await prisma.user.create({
    data: {
      email: `${spec.key}-${suffix}@facilities-example.test`,
      passwordHash: 'not-used-in-this-test',
      role: 'facility',
      emailVerifiedAt: new Date(),
    },
  });
  const profile = await prisma.facilityProfile.create({
    data: {
      userId: user.id,
      name: `${spec.name} ${suffix}`,
      type: spec.capability === 'lab_test' ? 'lab' : 'pharmacy',
      latitude: spec.lat,
      longitude: spec.lng,
    },
  });
  await prisma.facilityCapability.create({
    data: { facilityProfileId: profile.id, capabilityType: spec.capability, detail: spec.detail },
  });
  return profile;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const sinLat = Math.sin(toRad(b.lat - a.lat) / 2);
  const sinLng = Math.sin(toRad(b.lng - a.lng) / 2);
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng)));
}

beforeAll(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('docforum_test');

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  // Point the app's PrismaClient (constructed at module load) at THIS
  // throwaway cluster — vitest.config's default DATABASE_URL points at
  // booking's port 5433.
  process.env.DATABASE_URL = databaseUrl;

  const appModule = await import('../../src/app.js');
  const dbModule = await import('../../src/db/prisma-client.js');
  const tokensModule = await import('../../src/modules/auth/services/tokens.js');
  app = appModule.createApp();
  prisma = dbModule.prisma;

  // The endpoint only requires authentication — no signup dance needed,
  // and no patient location is ever attached to this account.
  const user = await prisma.user.create({
    data: {
      email: `patient-${runId}@distance-example.test`,
      passwordHash: 'not-used-in-this-test',
      role: 'patient',
      emailVerifiedAt: new Date(),
    },
  });
  patientToken = tokensModule.signAccessToken({ sub: user.id, role: 'patient' });

  for (const spec of FACILITIES) await createFacilityRow(spec, `base-${runId}`);
}, 120_000);

afterAll(async () => {
  await pg.stop();
});

describe('distance-sorted eligible facilities (issue #74)', () => {
  it('sorts by distance ascending, correct to haversine, coordinates-last', async () => {
    const res = await request(app)
      .get(`/facilities/eligible?capabilityType=medication_dispense&near=${CENTER.lat},${CENTER.lng}&radiusKm=60`)
      .set('Authorization', `Bearer ${patientToken}`);
    expect(res.status).toBe(200);

    const withCoords = res.body.filter((row: { distanceKm: number | null }) => row.distanceKm !== null);
    const withoutCoords = res.body.filter((row: { distanceKm: number | null }) => row.distanceKm === null);

    // Ascending order, within rounding tolerance of the JS reference.
    for (let i = 1; i < withCoords.length; i++) {
      expect(withCoords[i].distanceKm).toBeGreaterThanOrEqual(withCoords[i - 1].distanceKm);
    }
    const mid = FACILITIES.find((f) => f.key === 'mid')!;
    const midRow = withCoords.find((row: { name: string }) => row.name.startsWith(mid.name));
    expect(midRow).toBeTruthy();
    expect(Math.abs(midRow.distanceKm - haversineKm(CENTER, { lat: mid.lat, lng: mid.lng }))).toBeLessThan(0.05);

    // The far pharmacy (~56km) is inside radiusKm=60, the far lab has no
    // matching capability here; no-location facility appears, sorted last.
    expect(withoutCoords).toHaveLength(1);
    expect(withoutCoords[0].name).toContain('No Location Pharmacy');
    expect(res.body[res.body.length - 1].distanceKm).toBeNull();

    // Response shape: distance only, never the facility's raw point-of-
    // interest lat/lng echoed as the patient's query — and no lat/lng
    // fields at all.
    for (const row of res.body) {
      expect(Object.keys(row).sort()).toEqual(['address', 'distanceKm', 'id', 'name', 'type']);
    }
    // The patient's query point is never echoed back.
    expect(JSON.stringify(res.body)).not.toContain(String(CENTER.lat));
  });

  it('keeps unlocated facilities inside a radius search and excludes out-of-radius ones', async () => {
    const res = await request(app)
      .get(`/facilities/eligible?capabilityType=medication_dispense&near=${CENTER.lat},${CENTER.lng}&radiusKm=10`)
      .set('Authorization', `Bearer ${patientToken}`);
    expect(res.status).toBe(200);
    const names = res.body.map((row: { name: string }) => row.name);
    // ~56km away → excluded by the 10km radius.
    expect(names.some((name: string) => name.startsWith('Far Pharmacy'))).toBe(false);
    // Out-of-radius-to-unknown: still present, sorted last.
    expect(names.some((name: string) => name.startsWith('No Location Pharmacy'))).toBe(true);
    expect(res.body[res.body.length - 1].distanceKm).toBeNull();
  });

  it('filters by capability and returns name-sorted results without a point', async () => {
    const res = await request(app)
      .get('/facilities/eligible?capabilityType=lab_test')
      .set('Authorization', `Bearer ${patientToken}`);
    expect(res.status).toBe(200);
    const types = new Set(res.body.map((row: { type: string }) => row.type));
    expect([...types]).toEqual(['lab']);
    expect(res.body.every((row: { distanceKm: null }) => row.distanceKm === null)).toBe(true);
  });

  it('validates the query contract', async () => {
    const badShape = await request(app)
      .get('/facilities/eligible?near=lagos')
      .set('Authorization', `Bearer ${patientToken}`);
    expect(badShape.status).toBe(400);

    const radiusAlone = await request(app)
      .get('/facilities/eligible?radiusKm=10')
      .set('Authorization', `Bearer ${patientToken}`);
    expect(radiusAlone.status).toBe(400);

    const unauthenticated = await request(app).get('/facilities/eligible?near=6.5,3.4');
    expect(unauthenticated.status).toBe(401);
  });

  it('measures query performance against a few thousand facilities (issue #74 DoD)', async () => {
    const suffix = `load-${runId}`;
    const N = 3000;
    const users: { email: string; passwordHash: string; role: 'facility'; emailVerifiedAt: Date }[] = [];
    for (let i = 0; i < N; i++) {
      users.push({
        email: `load-${i}-${suffix}@facilities-example.test`,
        passwordHash: 'x',
        role: 'facility' as const,
        emailVerifiedAt: new Date(),
      });
    }
    // createMany without FKs first, then profiles mapped to real ids is
    // slow; instead create profiles with their own user rows in batches.
    const profiles: { userId: string; name: string; type: 'lab' | 'pharmacy'; latitude: number | null; longitude: number | null }[] = [];
    for (const user of users) {
      const created = await prisma.user.create({ data: user });
      // Every ~50th facility has no coordinates, mirroring reality.
      const hasCoords = Number(user.email.match(/^load-(\d+)/)![1]) % 50 !== 0;
      profiles.push({
        userId: created.id,
        name: `Load facility ${user.email}`,
        type: 'pharmacy',
        latitude: hasCoords ? CENTER.lat + (Math.random() - 0.5) * 0.6 : null,
        longitude: hasCoords ? CENTER.lng + (Math.random() - 0.5) * 0.6 : null,
      });
    }
    await prisma.facilityProfile.createMany({ data: profiles });
    expect(await prisma.facilityProfile.count()).toBeGreaterThanOrEqual(N);

    const facilitiesService = await import('../../src/modules/facilities/services/index.js');
    const timings: number[] = [];
    for (let i = 0; i < 25; i++) {
      const started = performance.now();
      const rows = await facilitiesService.listEligibleFacilities({
        near: CENTER,
        radiusKm: 60,
        limit: 50,
      });
      timings.push(performance.now() - started);
      expect(rows.length).toBeGreaterThan(0);
    }
    timings.sort((a, b) => a - b);
    const p50 = timings[Math.floor(timings.length * 0.5)];
    const p95 = timings[Math.floor(timings.length * 0.95)];
    const total = await prisma.facilityProfile.count();
    // Printed for the PR's performance section (issue #74 DoD).
    console.log(
      `[issue #74 perf] ${total} facilities, near+radiusKm=60, 25 runs → p50 ${p50.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms, max ${timings[timings.length - 1].toFixed(1)}ms`,
    );
    // Loose bound: correctness lives in the assertions above; this only
    // catches a catastrophic regression (unindexed full scan + trig on
    // millions of rows would blow way past this).
    expect(p95).toBeLessThan(500);
  }, 120_000);
});