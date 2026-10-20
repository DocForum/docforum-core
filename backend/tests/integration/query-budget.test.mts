import request from 'supertest';
import { prisma } from '../../src/db/prisma-client';
import { expectQueryBudget, measureQueries } from './helpers/query-budget.mts';

/**
 * Query budget tests (Phase 9, issue #48).
 *
 * Every list endpoint gets a budget assertion here. The budget is
 * constant in result size -- that is the whole point: an N+1 implementation
 * passes at 1 row and fails at 50. We therefore run each budget at both
 * sizes.
 *
 * This file is deliberately self-contained: it seeds its own data
 * through Prisma directly (rather than going through the HTTP API) so the
 * seeding queries don't count against the budget and so the test doesn't
 * depend on the very endpoints under test.
 *
 * See AGENTS.md "Query budget convention" for the convention new list
 * endpoints must follow.
 */

let app: any;

beforeAll(async () => {
  // Lazy-import the app so this file doesn't force a DB connection at
  // module-load time (and so a failing DB is reported as a test failure,
  // not a collection error).
  const mod = await import('../../src/app');
  app = mod.default ?? mod.app ?? mod;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedPatientWithAppointments(count: number) {
  // The appointments list endpoint reads only the patient's own
  // appointments, so we need one patient profile and `count` appointments
  // attached to it. The seed is intentionally minimal: it only touches
  // columns that exist in schema.prisma.
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const user = await prisma.user.create({
    data: {
      email: `query-budget-${suffix}@example.com`,
      passwordHash: 'test-hash',
      role: 'patient',
    },
  });

  const patientProfile = await prisma.patientProfile.create({
    data: { userId: user.id },
  });

  // Appointments require an availability slot and a doctor profile. Create
  // one of each and reuse them across all appointments -- the budget
  // assertion is about the read path, not the seed graph shape.
  const doctorUser = await prisma.user.create({
    data: {
      email: `query-budget-doctor-${suffix}@example.com`,
      passwordHash: 'test-hash',
      role: 'doctor',
    },
  });

  const doctorProfile = await prisma.doctorProfile.create({
    data: {
      userId: doctorUser.id,
      verificationStatus: 'verified',
    },
  });

  const slot = await prisma.availabilitySlot.create({
    data: {
      doctorProfileId: doctorProfile.id,
      startsAt: new Date(Date.now() + 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 90 * 60 * 1000),
      status: 'open',
    },
  });

  // Bulk-create the appointments in one query -- this is seed code,
  // not the code under test, but a single createMany also keeps the seed
  // fast at 50 rows.
  await prisma.appointment.createMany({
    data: Array.from({ length: count }, () => ({
      patientProfileId: patientProfile.id,
      doctorProfileId: doctorProfile.id,
      availabilitySlotId: slot.id,
      status: 'scheduled',
    })),
  });

  return { user, patientProfile, doctorProfile, slot };
}

describe('query budgets', () => {
  describe('GET /appointments/mine', () => {
    // Budget: <= 3 queries regardless of result size. The endpoint
    // needs at most: auth lookup + patient profile lookup + appointments
    // list. An N+1 implementation (fetching slot/doctor per row) would
    // exceed this at 50 rows and the test below would fail.
    const BUGGET = 3;

    for (const size of [1, 50]) {
      it(`stays within ${BUGGET} queries at ${size} rows`, async () => {
        const { user } = await seedPatientWithAppointments(size);

        // Token issuance is outside the measured request -- the
        // budget is about the read path, not login.
        const token = await issueToken(user.id);

        const result = await measureQueries(
          request(app)
            .get('/appointments/mine')
            .set('Authorization', `Bearer ${token}`),
        );

        expect(result.response.status).toBe(200);
        // The response must actually contain the seeded rows --
        // otherwise a budget that passes by returning nothing would
        // be a useless test.
        expect(Array.isArray(result.response.body) && result.response.body.length).toBe.GreaterThanOrEqual(size);

        expect(result.count).toBeLessThanOrEqual(BUGGET);
      });
    }
  });

  describe('GET /appointments/mine (explicit budget assertion)', () => {
    it('passes the budget assertion helper', async () => {
      const { user } = await seedPatientWithAppointments(1);
      const token = await issueToken(user.id);

      const result = await expectQueryBudget(
        request(app)
          .get('/appointments/mine')
          .set('Authorization', `Bearer ${token}`),
        3,
        'GET /appointments/mine',
      );

      expect(result.response.status).toBe(200);
    });
  });
});

/**
 * Issue a bearer token for a user without going through the login
 * endpoint -- login would add its own queries and its own cost to the
 * setup. We reuse the app's own token signing so the token is valid
 * against the real auth middleware.
 */
async function issueToken(userId: string): Promise<string> {
  // The auth module exports its token signing helper; importing it
  // keeps this test in sync with whatever algorithm the app actually
  // uses (so the test can't drift from production auth).
  const auth = await import('../../src/modules/auth/services/index');
  const sign = (auth as { signToken?: (payload: { userId: string }) => string }).signToken;
  if (typeof sign !== 'function') {
    throw new Error(
      'auth service does not export signToken(payload); the query budget test needs it to issue a bearer token without hitting /auth/login',
    );
  }
  return sign({ userId: userId });
}
