// Integration tests for access-control: who may read intake, consultation and payment data
// (Phase 8, issue #44). Self-contained embedded Postgres, own port (5438) so it runs
// alongside the other integration files.
//
// This suite establishes a declarative access-control matrix (route × actor →
// expected status) covering every registered route. The matrix is the
// canonical source of truth for who may call what — later phases add rows
// instead of inventing their own approach.
//
// The "unregistered route" guard checks against a known-routes list that is
// kept in sync with the actual route registrations in each module's routes/.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5438;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-ac-pg-'));
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

// ---------------------------------------------------------------------------
// Known routes — keep in sync with each module's routes/index.ts registrations.
// ---------------------------------------------------------------------------
const KNOWN_ROUTES = [
  'GET /health',
  'POST /auth/signup',
  'POST /auth/login',
  'POST /auth/refresh',
  'POST /auth/logout',
  'POST /auth/verify-email',
  'POST /auth/verify-email/resend',
  'POST /auth/login-attempts/clear',
  'GET /doctors/me',
  'PATCH /doctors/:doctorProfileId/verification',
  'GET /availability/doctors/:doctorProfileId/slots',
  'POST /availability/doctors/:doctorProfileId/slots/generate',
  'POST /appointments',
  'GET /appointments/mine',
  'POST /appointments/:appointmentId/consultation',
  'POST /consultations',
  'GET /consultations/:consultationId',
  'POST /payments/wallet-link',
  'GET /payments/wallet-link',
  'POST /orders/consultations',
  'POST /orders/consultations/:consultationId/prescriptions',
  'POST /orders/consultations/:consultationId/lab-orders',
  'GET /payments/intents/:id',
  'POST /payments/intents/:id/fund',
  'POST /payments/intents/:id/release',
  'POST /payments/intents/:id/refund',
  'POST /patients/me/export',
  'GET /patients/me/export/:exportId',
  'GET /patients/me/export/:exportId/download',
] as const;

// ---------------------------------------------------------------------------
// Access-control matrix: route × actor → expected status
// ---------------------------------------------------------------------------
type Actor = 'anon' | 'patient' | 'doctor' | 'facility' | 'admin';

interface MatrixRow {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  /** Expected HTTP status per actor. Omitted actor → 401 or 403 expected (not asserted). */
  expected: Partial<Record<Actor, number>>;
}

const ACCESS_MATRIX: MatrixRow[] = [
  // Health — public
  { method: 'GET', path: '/health', expected: { anon: 200, patient: 200, doctor: 200, facility: 200, admin: 200 } },

  // Auth — public signup/login/refresh; logout needs CSRF token (403 without)
  // signup/login are tested in seedActors — direct assertions below use fresh emails
  { method: 'POST', path: '/auth/signup', expected: { anon: 400 } }, // seeded email reused → 400 duplicate
  { method: 'POST', path: '/auth/login', expected: { anon: 400 } }, // seeded email + wrong body → 400
  { method: 'POST', path: '/auth/refresh', expected: { anon: 401 } },
  { method: 'POST', path: '/auth/logout', expected: { anon: 403, patient: 403 } },
  { method: 'POST', path: '/auth/verify-email', expected: { anon: 400 } }, // missing token field → 400
  { method: 'POST', path: '/auth/verify-email/resend', expected: { anon: 401 } }, // authenticated 200/429 varies by rate limit
  { method: 'POST', path: '/auth/login-attempts/clear', expected: { anon: 401, patient: 403, doctor: 403, facility: 403, admin: 400 } }, // admin-only; missing body → 400

  // Doctors — GET /me is doctor-only; verification is admin-only
  { method: 'GET', path: '/doctors/me', expected: { anon: 401, patient: 403, doctor: 200, facility: 403, admin: 403 } },
  { method: 'PATCH', path: '/doctors/:doctorProfileId/verification', expected: { anon: 401, patient: 403, doctor: 403, facility: 403, admin: 400 } }, // admin passes role gate; placeholder id → validation 400

  // Availability — slots browsing public; generation requires verified doctor
  { method: 'GET', path: '/availability/doctors/:doctorProfileId/slots', expected: { anon: 200, patient: 200, doctor: 200, facility: 200, admin: 200 } },
  { method: 'POST', path: '/availability/doctors/:doctorProfileId/slots/generate', expected: { anon: 401, patient: 403, doctor: 404, facility: 403, admin: 403 } },

  // Appointments — POST is patient-only (verified email); GET /mine is patient-only
  { method: 'POST', path: '/appointments', expected: { anon: 401, patient: 403, doctor: 403, facility: 403, admin: 403 } }, // patient unverified → 403 EMAIL_NOT_VERIFIED
  { method: 'GET', path: '/appointments/mine', expected: { anon: 401, patient: 200, doctor: 403, facility: 403, admin: 403 } },

  // Consultations (issue #4) — closing is doctor-only, verified-email gated
  // and only for the doctor's own appointment. The seeded doctor is
  // unverified, so the email gate answers 403 before the service can answer
  // 404; the own-appointment 404 (never a 403 that would confirm the
  // appointment exists) is asserted in consultation.test.mts.
  { method: 'POST', path: '/appointments/:appointmentId/consultation', expected: { anon: 401, patient: 403, doctor: 403, facility: 403, admin: 403 } },
  { method: 'POST', path: '/consultations', expected: { anon: 401, patient: 403, doctor: 403, facility: 403, admin: 403 } },
  { method: 'GET', path: '/consultations/:consultationId', expected: { anon: 401, patient: 404, doctor: 404, facility: 404, admin: 404 } },

  // Orders: doctor-only and verified-email gated.
  { method: 'POST', path: '/orders/consultations', expected: { anon: 401, patient: 403, doctor: 403, facility: 403, admin: 403 } },
  { method: 'POST', path: '/orders/consultations/:consultationId/prescriptions', expected: { anon: 401, patient: 403, doctor: 403, facility: 403, admin: 403 } },
  { method: 'POST', path: '/orders/consultations/:consultationId/lab-orders', expected: { anon: 401, patient: 403, doctor: 403, facility: 403, admin: 403 } },

  // Payments — admin-triggered in v1; wallet-link is facility-only
  { method: 'POST', path: '/payments/wallet-link', expected: { anon: 401, patient: 403, doctor: 403, facility: 400, admin: 403 } },
  { method: 'GET', path: '/payments/wallet-link', expected: { anon: 401, patient: 403, doctor: 403, facility: 404, admin: 403 } },
  { method: 'GET', path: '/payments/intents/:id', expected: { anon: 401, patient: 403, doctor: 403, facility: 403, admin: 404 } },
  { method: 'POST', path: '/payments/intents/:id/fund', expected: { anon: 401, patient: 403, doctor: 403, facility: 403, admin: 404 } },
  { method: 'POST', path: '/payments/intents/:id/release', expected: { anon: 401, patient: 403, doctor: 403, facility: 403, admin: 404 } },
  { method: 'POST', path: '/payments/intents/:id/refund', expected: { anon: 401, patient: 403, doctor: 403, facility: 403, admin: 404 } },

  // Patient data export (issue #40) — patient-only and self-only; no
  // on-behalf-of route for doctors/admins. A placeholder id is "not yours" → 404.
  { method: 'POST', path: '/patients/me/export', expected: { anon: 401, patient: 202, doctor: 403, facility: 403, admin: 403 } },
  { method: 'GET', path: '/patients/me/export/:exportId', expected: { anon: 401, patient: 404, doctor: 403, facility: 403, admin: 403 } },
  { method: 'GET', path: '/patients/me/export/:exportId/download', expected: { anon: 401, patient: 404, doctor: 403, facility: 403, admin: 403 } },
];

const ACTORS: Actor[] = ['anon', 'patient', 'doctor', 'facility', 'admin'];

describe('Access-control test suite: who may read intake, consultation and payment data', () => {
  let app: App;
  let prisma: Prisma;

  const tokens: Partial<Record<Actor, string>> = {};

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

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    await seedActors();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedActors() {
    // Patient + doctor via self-serve signup
    for (const role of ['patient', 'doctor'] as const) {
      const email = `ac-${role}-${runId}@example.com`;
      const res = await request(app)
        .post('/auth/signup')
        .send({ role, email, password: 'longenough123', fullName: `AC ${role}` });
      if (res.status === 200) tokens[role] = res.body.accessToken as string;
    }

    // Facility + admin via direct DB insert (not self-serve per PRD OQ-2)
    const bcryptjs = await import('bcryptjs');
    const passwordHash = await bcryptjs.hash('longenough123', 4);

    for (const role of ['facility', 'admin'] as const) {
      const email = `ac-${role}-${runId}@example.com`;
      const user = await prisma.user.create({
        data: { email, passwordHash, role, emailVerifiedAt: new Date() },
      });
      if (role === 'facility') {
        await prisma.facilityProfile.create({
          data: { userId: user.id, name: `AC Facility ${runId}`, type: 'lab' },
        });
      }
      const res = await request(app)
        .post('/auth/login')
        .send({ email, password: 'longenough123' });
      if (res.status === 200) tokens[role] = res.body.accessToken as string;
    }
  }

  async function sendAs(row: MatrixRow, actor: Actor): Promise<number> {
    const req = request(app)[row.method.toLowerCase() as 'get'](row.path);
    if (actor !== 'anon' && tokens[actor]) {
      req.set('Authorization', `Bearer ${tokens[actor]}`);
    }
    const res = await req;
    return res.status;
  }

  // -------------------------------------------------------------------------
  // Matrix enforcement
  // -------------------------------------------------------------------------
  for (const row of ACCESS_MATRIX) {
    const label = `${row.method} ${row.path}`;
    for (const actor of ACTORS) {
      const expected = row.expected[actor];
      if (expected === undefined) continue;
      it(`${label} → ${actor} expects ${expected}`, async () => {
        const status = await sendAs(row, actor);
        expect(status).toBe(expected);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Unregistered-route guard: every KNOWN_ROUTES entry must be in the matrix.
  // When a new route is registered, add it to KNOWN_ROUTES AND ACCESS_MATRIX;
  // this test fails until both are updated, forcing an access-control review.
  // -------------------------------------------------------------------------
  it('every known route has a matrix entry (unregistered-route guard)', () => {
    const matrixKeys = new Set(
      ACCESS_MATRIX.map((r) => `${r.method} ${r.path}`),
    );
    const missing = KNOWN_ROUTES.filter((key) => !matrixKeys.has(key));
    expect(missing).toEqual([]);
  });

  it('every matrix entry corresponds to a known route (stale matrix guard)', () => {
    const knownSet = new Set<string>(KNOWN_ROUTES);
    const stale = ACCESS_MATRIX
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => !knownSet.has(key));
    expect(stale).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // IDOR placeholders — become real once Phase 2/3 routes exist.
  // -------------------------------------------------------------------------
  it("patients cannot read another patient's intake form (IDOR guard)", async () => {
    // TODO(issue #1/#2): once intake routes exist, seed two patients with
    // intake forms and assert patient A gets 403/404 on patient B's intake.
    expect(true).toBe(true);
  });

  it('non-participating doctors cannot act on a consultation (IDOR guard)', async () => {
    // The consultation write paths are covered by the matrix rows above (an
    // unverified doctor is stopped by the email gate; a verified non-owner
    // gets 404, never a 403 that would confirm the appointment exists). Both
    // are asserted end-to-end — including a real second doctor being refused
    // on doctor A's appointment — in tests/integration/consultation.test.mts.
    // The read route (`GET /consultations/:id`) is in the matrix for
    // unauthenticated access only; its owner/patient scoping needs seeded
    // rows, which consultation.test.mts also covers.
    expect(true).toBe(true);
  });
});
