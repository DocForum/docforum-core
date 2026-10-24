import { describe, it, before, after, beforeEach, expect } from 'vitest';
import supertest from 'supertest';
import type { Express } from 'express';

/**
 * Query budget tests.
 *
 * Purpose: catch N+1 queries on list endpoints. A query count is a tested
 * property of every list endpoint: the number of Prisma queries a request issues
 * must not grow with the result size.
 *
 * The count is per-request (correlated via AsyncLocalStorage), not global, so
 * parallel tests cannot interfere with each other.
 *
 * Convention: every new list endpoint must add a case here asserting a constant
 * budget at both 1 and 50 rows. See AGENTS.md for the full convention.
 */

import { createApp } from '../../src/app';
import { prisma } from '../../src/db/prisma-client';
import { installQueryCounter, measureQueries } from './helpers/query-budget';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  throw new Error('TEST_DATABASE_URL must be set to run query budget tests');
}

const app: Express = createApp();

let adminToken: string;
let doctorToken: string;
let patientToken: string;
let doctorId: string;
let patientId: string;
let adminId: string;

before(async () => {
  installQueryCounter(prisma);
  await prisma.$connect();
  await seedTestData();
});

after(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Reset data that each case depends on, but keep auth users stable.
  await prisma.appointment.deleteMany({});
  await prisma.prescription.deleteMany({});
  await prisma.referral.deleteMany({});
});

async function seedTestData(): Promise<void> {
  const suffix = Date.now().toString(36);

  const admin = await prisma.user.create({
    data: {
      email: `qb-admin-${suffix}@example.org`,
      passwordHash: 'x',
      role: 'ADMIN',
    },
  });
  const doctorUser = await prisma.user.create({
    data: {
      email: `qb-doctor-${suffix}@example.org`,
      passwordHash: 'x',
      role: 'DOCTOR',
    },
  });
  const patientUser = await prisma.user.create({
    data: {
      email: `qb-patient-${suffix}@example.org`,
      passwordHash: 'x',
      role: 'PATIENT',
    },
  });

  const doctor = await prisma.doctor.create({
    data: {
      userId: doctorUser.id,
      specialty: 'General',
    },
  });
  const patient = await prisma.patient.create({
    data: {
      userId: patientUser.id,
    },
  });

  adminId = admin.id;
  doctorId = doctor.id;
  patientId = patient.id;

  adminToken = await signIn(admin.email);
  doctorToken = await signIn(doctorUser.email);
  patientToken = await signIn(patientUser.email);
}

async function signIn(email: string): Promise<string> {
  const res = await supertest(app)
    .post('/auth/login')
    .send({ email, password: 'x' });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

async function seedAppointments(count: number): Promise<void> {
  const base = Date.now() + 86400000;
  for (let i = 0; i < count; i++) {
    await prisma.appointment.create({
      data: {
        patientId,
        doctorId,
        startsAt: new Date(base + i * 60 * 60 * 1000),
        endsAt: new Date(base + i * 60 * 60 * 1000 + 30 * 60 * 1000),
        status: 'SCHEDULED',
      },
    });
  }
}

async function getCount(
  req: () => Promise<supertest.Response>,
): Promise<number> {
  const { count } = await measureQueries(req);
  return count;
}

describe('Query budgets - list endpoints', () => {
  it('GET /appointments/mine -> constant budget at 1 and 50 rows', async () => {
    await seedAppointments(1);
    const count1 = await getCount(() =>
      supertest(app)
        .get('/appointments/mine')
        .set('Authorization', `Bearer ${patientToken}`),
    );

    await seedAppointments(49);
    const count50 = await getCount(() =>
      supertest(app)
        .get('/appointments/mine')
        .set('Authorization', `Bearer ${patientToken}`),
    );

    expect(count1).toBeLessThanOrEqual(3);
    expect(count50).toBeLessThanOrEqual(3);
    expect(count50).toEqual(count1);
  });

  it('GET /appointments -> constant budget at 1 and 50 rows', async () => {
    await seedAppointments(1);
    const count1 = await getCount(() =>
      supertest(app)
        .get('/appointments')
        .set('Authorization', `Bearer ${adminToken}`),
    );

    await seedAppointments(49);
    const count50 = await getCount(() =>
      supertest(app)
        .get('/appointments')
        .set('Authorization', `Bearer ${adminToken}`),
    );

    expect(count1).toBeLessThanOrEqual(3);
    expect(count50).toBeLessThanOrEqual(3);
    expect(count50).toEqual(count1);
  });

  it('GET /doctors -> constant budget at 1 and 50 rows', async () => {
    const count1 = await getCount(() =>
      supertest(app)
        .get('/doctors')
        .set('Authorization', `Bearer ${patientToken}`),
    );

    const suffix = Date.now().toString(36);
    for (let i = 0; i < 49; i++) {
      const u = await prisma.user.create({
        data: {
          email: `qb-doc-${suffix}-${i}@example.org`,
          passwordHash: 'x',
          role: 'DOCTOR',
        },
      });
      await prisma.doctor.create({
        data: { userId: u.id, specialty: 'General' },
      });
    }

    const count50 = await getCount(() =>
      supertest(app)
        .get('/doctors')
        .set('Authorization', `Bearer ${patientToken}`),
    );

    expect(count1).toBeLessThanOrEqual(2);
    expect(count50).toBeLessThanOrEqual(2);
    expect(count50).toEqual(count1);
  });

  it('GET /prescriptions/mine -> constant budget at 1 and 50 rows', async () => {
    const seed = async (n): Promise<void> => {
      for (let i = 0; i < n; i++) {
        await prisma.prescription.create({
          data: {
            patientId,
            doctorId,
            medication: `Medication ${i}`,
            dosage: '100mg',
          },
        });
      }
    };
    await seed(1);
    const count1 = await getCount(() =>
      supertest(app)
        .get('/prescriptions/mine')
        .set('Authorization', `Bearer ${patientToken}`),
    );

    await seed(49);
    const count50 = await getCount(() =>
      supertest(app)
        .get('/prescriptions/mine')
        .set('Authorization', `Bearer ${patientToken}`),
    );

    expect(count1).toBeLessThanOrEqual(3);
    expect(count50).toBeLessThanOrEqual(3);
    expect(count50).toEqual(count1);
  });

  it('GET /referrals/mine -> constant budget at 1 and 50 rows', async () => {
    const seed = async (n): Promise<void> => {
      for (let i = 0; i < n; i++) {
        await prisma.referral.create({
          data: {
            patientId,
            doctorId,
            reason: `Reason ${i}`,
            status: 'PENDING',
          },
        });
      }
    };
    await seed(1);
    const count1 = await getCount(() =>
      supertest(app)
        .get('/referrals/mine')
        .set('Authorization', `Bearer ${patientToken}`),
    );

    await seed(49);
    const count50 = await getCount(() =>
      supertest(app)
        .get('/referrals/mine')
        .set('Authorization', `Bearer ${patientToken}`),
    );

    expect(count1).toBeLessThanOrEqual(3);
    expect(count50).toBeLessThanOrEqual(3);
    expect(count50).toEqual(count1);
  });

  it('GET /orders/mine -> constant budget at 1 and 50 rows', async () => {
    const seed = async (n): Promise<void> => {
      for (let i = 0; i < n; i++) {
        await prisma.order.create({
          data: {
            patientId,
            totalCents: 1000 + i,
            status: 'PENDING',
          },
        });
      }
    };
    await seed(1);
    const count1 = await getCount(() =>
      supertest(app)
        .get('/orders/mine')
        .set('Authorization', `Bearer ${patientToken}`),
    );

    await seed(49);
    const count50 = await getCount(() =>
      supertest(app)
        .get('/orders/mine')
        .set('Authorization', `Bearer ${patientToken}`),
    );

    expect(count1).toBeLessThanOrEqual(3);
    expect(count50).toBeLessThanOrEqual(3);
    expect(count50).toEqual(count1);
  });
});
