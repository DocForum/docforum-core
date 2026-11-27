// Per-request Prisma query budgets (issue #122).
//
// The budget assertion has to hold at 1 row AND at 50 rows: a number that
// grows with the fixture is an N+1, and that is exactly the bug class that
// passes functional tests and then misses the ~300 ms list target in
// production. This suite seeds both sizes for the list endpoints that grow
// with a patient's or doctor's history, measures each request through
// `tests/helpers/query-budget.ts`, and asserts a constant budget.
//
// Self-contained like the other integration suites: its own throwaway
// Postgres on port 5492, UTF-8 encoded (the migration that inserts an arrow
// character fails under a WIN1252 cluster), migrations applied via the
// local Prisma CLI rather than `npx` so it runs on Windows too.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { expectQueryBudget, measureQueries } from '../helpers/query-budget.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5492;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-query-budgets-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
  initdbFlags: ['--encoding=UTF8'],
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_query_budgets_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;
type Role = 'patient' | 'doctor' | 'facility' | 'admin';

describe('query budgets for list endpoints', () => {
  let app: App;
  let prisma: Prisma;
  let signAccessToken: (payload: { sub: string; role: Role }) => string;

  let smallPatientToken: string;
  let manyPatientToken: string;
  let smallDoctorToken: string;
  let manyDoctorToken: string;
  let smallFacilityToken: string;
  let manyFacilityToken: string;

  async function createUser(role: Role, label: string) {
    const user = await prisma.user.create({
      data: {
        email: `${role}-${label}-${runId}@example.com`,
        passwordHash: 'unused-in-test',
        role,
        emailVerifiedAt: new Date(),
      },
    });
    return { user, token: signAccessToken({ sub: user.id, role }) };
  }

  async function createPatient(label: string) {
    const { user, token } = await createUser('patient', label);
    const profile = await prisma.patientProfile.create({
      data: { userId: user.id, fullName: `Patient ${label}` },
    });
    return { user, token, profile };
  }

  async function createDoctor(label: string) {
    const { user, token } = await createUser('doctor', label);
    const profile = await prisma.doctorProfile.create({
      data: {
        userId: user.id,
        fullName: `Doctor ${label}`,
        timeZone: 'UTC',
        verificationStatus: 'verified',
      },
    });
    return { user, token, profile };
  }

  /** `count` booked appointments (and, when `withConsultation`, a consultation
   * each) for one patient/doctor pair, starting on a fixed future day so the
   * doctor schedule range is stable. Returns the consultation ids. */
  async function seedVisits(
    patientProfileId: string,
    doctorProfileId: string,
    count: number,
    withConsultation: boolean,
  ): Promise<string[]> {
    const base = new Date('2031-05-06T09:00:00Z').getTime();
    const consultationIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const startTime = new Date(base + index * 30 * 60_000);
      const slot = await prisma.availabilitySlot.create({
        data: {
          doctorProfileId,
          status: 'booked',
          startTime,
          endTime: new Date(startTime.getTime() + 25 * 60_000),
        },
      });
      const appointment = await prisma.appointment.create({
        data: { patientProfileId, doctorProfileId, availabilitySlotId: slot.id, status: 'scheduled' },
      });
      if (withConsultation) {
        const consultation = await prisma.consultation.create({
          data: { appointmentId: appointment.id, outcome: 'resolved', signedAt: new Date() },
        });
        consultationIds.push(consultation.id);
      }
    }
    return consultationIds;
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_query_budgets_test');
    execFileSync(
      process.execPath,
      [path.join(BACKEND_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      {
        cwd: BACKEND_ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
      },
    );

    process.env.DATABASE_URL = databaseUrl;
    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const tokensModule = await import('../../src/modules/auth/services/tokens.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;
    signAccessToken = tokensModule.signAccessToken;

    const smallPatient = await createPatient('small');
    const manyPatient = await createPatient('many');
    const smallDoctor = await createDoctor('small');
    const manyDoctor = await createDoctor('many');
    smallPatientToken = smallPatient.token;
    manyPatientToken = manyPatient.token;
    smallDoctorToken = smallDoctor.token;
    manyDoctorToken = manyDoctor.token;

    async function createFacility(label: string, name: string) {
      const account = await createUser('facility', label);
      const profile = await prisma.facilityProfile.create({
        data: { userId: account.user.id, name, type: 'pharmacy' },
      });
      await prisma.facilityCapability.create({
        data: { facilityProfileId: profile.id, capabilityType: 'medication_dispense' },
      });
      return { profile, token: account.token };
    }
    const smallFacility = await createFacility('facility-small', 'Small Query Budget Pharmacy');
    const manyFacility = await createFacility('facility-many', 'Many Query Budget Pharmacy');
    smallFacilityToken = smallFacility.token;
    manyFacilityToken = manyFacility.token;

    const smallConsultations = await seedVisits(smallPatient.profile.id, smallDoctor.profile.id, 1, true);
    const manyConsultations = await seedVisits(manyPatient.profile.id, manyDoctor.profile.id, 50, true);

    // One referral per consultation, all pointed at the same target doctor, so
    // the patient's and the target doctor's referral lists are the 1/50 pair.
    for (const [index, consultationId] of manyConsultations.entries()) {
      await prisma.referral.create({
        data: {
          patientProfileId: manyPatient.profile.id,
          sourceConsultationId: consultationId,
          referringDoctorId: smallDoctor.profile.id,
          targetDoctorId: manyDoctor.profile.id,
          snapshotNotes: `many referral ${index}`,
        },
      });
    }
    const smallCalendarToken = 'a'.repeat(64);
    const manyCalendarToken = 'b'.repeat(64);
    await prisma.doctorCalendarFeed.createMany({
      data: [
        {
          doctorProfileId: smallDoctor.profile.id,
          tokenHash: createHash('sha256').update(smallCalendarToken).digest('hex'),
        },
        {
          doctorProfileId: manyDoctor.profile.id,
          tokenHash: createHash('sha256').update(manyCalendarToken).digest('hex'),
        },
      ],
    });
    await prisma.referral.create({
      data: {
        patientProfileId: smallPatient.profile.id,
        sourceConsultationId: smallConsultations[0]!,
        referringDoctorId: manyDoctor.profile.id,
        targetDoctorId: smallDoctor.profile.id,
        snapshotNotes: 'small referral',
      },
    });

    // Prescriptions (with one fulfillment record each) so both the patient's
    // order list and the facility's queue are measured at both sizes.
    for (const consultationId of manyConsultations) {
      const prescription = await prisma.prescription.create({
        data: {
          consultationId,
          patientProfileId: manyPatient.profile.id,
          prescribingDoctorId: manyDoctor.profile.id,
          facilityProfileId: manyFacility.profile.id,
          amountStroops: 1_000n,
        },
      });
      await prisma.fulfillmentRecord.create({
        data: { prescriptionId: prescription.id, facilityId: manyFacility.profile.id },
      });
    }
    const smallPrescription = await prisma.prescription.create({
      data: {
        consultationId: smallConsultations[0]!,
        patientProfileId: smallPatient.profile.id,
        prescribingDoctorId: smallDoctor.profile.id,
        facilityProfileId: smallFacility.profile.id,
        amountStroops: 1_000n,
      },
    });
    await prisma.fulfillmentRecord.create({
      data: { prescriptionId: smallPrescription.id, facilityId: smallFacility.profile.id },
    });

    await prisma.notification.createMany({
      data: Array.from({ length: 50 }, (_, index) => ({
        userId: manyPatient.user.id,
        type: 'appointment_booked',
        payload: { appointmentId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` },
      })),
    });
    await prisma.notification.create({
      data: { userId: smallPatient.user.id, type: 'appointment_booked', payload: { appointmentId: '00000000-0000-4000-8000-000000000099' } },
    });

    // Public doctor search: 50 verified doctors with a specialty and one open
    // slot each, plus the two doctors above. Measured with `limit=1` and
    // `limit=50` (result size, not a different query shape).
    const specialty = await prisma.specialty.create({
      data: { name: `Query Budget Specialty ${runId}`, slug: `query-budget-${runId}` },
    });
    for (let index = 0; index < 50; index += 1) {
      const doctor = await createDoctor(`directory-${index}`);
      await prisma.doctorSpecialty.create({
        data: { doctorProfileId: doctor.profile.id, specialtyId: specialty.id },
      });
      await prisma.availabilitySlot.create({
        data: {
          doctorProfileId: doctor.profile.id,
          status: 'open',
          startTime: new Date(Date.now() + 24 * 60 * 60_000 + index * 60_000),
          endTime: new Date(Date.now() + 24 * 60 * 60_000 + index * 60_000 + 30 * 60_000),
        },
      });
    }
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  /** Both fixture sizes for one endpoint, measured against the same budget. */
  async function expectConstantBudget(
    budget: number,
    small: (agent: ReturnType<typeof request>) => request.Test,
    many: (agent: ReturnType<typeof request>) => request.Test,
  ) {
    const one = await expectQueryBudget(app, small, budget);
    const fifty = await expectQueryBudget(app, many, budget);
    expect(one.response.status).toBe(200);
    expect(fifty.response.status).toBe(200);
    return { one, fifty };
  }

  it('keeps GET /appointments/mine constant from 1 to 50 appointments', async () => {
    const { one, fifty } = await expectConstantBudget(
      5,
      (a) => a.get('/appointments/mine').set('Authorization', `Bearer ${smallPatientToken}`),
      (a) => a.get('/appointments/mine').set('Authorization', `Bearer ${manyPatientToken}`),
    );
    // Guard the fixtures themselves: if both lists returned 0 rows the budget
    // would pass without exercising anything.
    expect(one.response.body).toHaveLength(1);
    expect(fifty.response.body).toHaveLength(50);
  });

  it('keeps GET /appointments/doctor constant from 1 to 50 appointments', async () => {
    const range = '?from=2031-05-05&to=2031-05-08';
    const { one, fifty } = await expectConstantBudget(
      6,
      (a) => a.get(`/appointments/doctor${range}`).set('Authorization', `Bearer ${smallDoctorToken}`),
      (a) => a.get(`/appointments/doctor${range}`).set('Authorization', `Bearer ${manyDoctorToken}`),
    );
    expect(one.response.body).toHaveLength(1);
    expect(fifty.response.body).toHaveLength(50);
  });

  it('keeps GET /calendar/:token.ics constant from 1 to 50 appointments', async () => {
    const { one, fifty } = await expectConstantBudget(
      4,
      (a) => a.get(`/calendar/${'a'.repeat(64)}.ics`),
      (a) => a.get(`/calendar/${'b'.repeat(64)}.ics`),
    );
    expect((one.response.text.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
    expect((fifty.response.text.match(/BEGIN:VEVENT/g) ?? []).length).toBe(50);
  });

  it('keeps GET /consultations/mine constant as the page grows', async () => {
    const { one, fifty } = await expectConstantBudget(
      9,
      (a) => a.get('/consultations/mine').set('Authorization', `Bearer ${smallPatientToken}`),
      (a) => a.get('/consultations/mine').set('Authorization', `Bearer ${manyPatientToken}`),
    );
    expect(one.response.body.items).toHaveLength(1);
    // The page is capped at 20; the point is the query count, not page size.
    expect(fifty.response.body.items).toHaveLength(20);
  });

  it('keeps GET /consultations/doctor constant as the page grows', async () => {
    const { one, fifty } = await expectConstantBudget(
      10,
      (a) => a.get('/consultations/doctor').set('Authorization', `Bearer ${smallDoctorToken}`),
      (a) => a.get('/consultations/doctor').set('Authorization', `Bearer ${manyDoctorToken}`),
    );
    expect(one.response.body.items).toHaveLength(1);
    expect(fifty.response.body.items).toHaveLength(20);
  });

  // Regression test for the N+1 this issue found: the list used to write one
  // AccessLog row per referral (53 queries at 50 rows). Access logs are now one
  // batched INSERT, so the count stays flat.
  it('keeps GET /referrals/mine constant from 1 to 50 referrals', async () => {
    const { one, fifty } = await expectConstantBudget(
      5,
      (a) => a.get('/referrals/mine').set('Authorization', `Bearer ${smallPatientToken}`),
      (a) => a.get('/referrals/mine').set('Authorization', `Bearer ${manyPatientToken}`),
    );
    expect(one.response.body.referrals).toHaveLength(1);
    expect(fifty.response.body.referrals).toHaveLength(50);
  });

  it('keeps GET /referrals/incoming constant as the page grows', async () => {
    const { one, fifty } = await expectConstantBudget(
      5,
      (a) => a.get('/referrals/incoming').set('Authorization', `Bearer ${smallDoctorToken}`),
      (a) => a.get('/referrals/incoming').set('Authorization', `Bearer ${manyDoctorToken}`),
    );
    expect(one.response.body.items).toHaveLength(1);
    expect(fifty.response.body.items).toHaveLength(20);
  });

  it('keeps GET /orders/mine constant from 1 to 50 prescriptions', async () => {
    const { one, fifty } = await expectConstantBudget(
      4,
      (a) => a.get('/orders/mine').set('Authorization', `Bearer ${smallPatientToken}`),
      (a) => a.get('/orders/mine').set('Authorization', `Bearer ${manyPatientToken}`),
    );
    expect(one.response.body.prescriptions).toHaveLength(1);
    expect(fifty.response.body.prescriptions).toHaveLength(50);
  });

  it('keeps GET /notifications constant from 1 to 50 notifications', async () => {
    const { one, fifty } = await expectConstantBudget(
      2,
      (a) => a.get('/notifications?limit=50').set('Authorization', `Bearer ${smallPatientToken}`),
      (a) => a.get('/notifications?limit=50').set('Authorization', `Bearer ${manyPatientToken}`),
    );
    expect(one.response.body.items).toHaveLength(1);
    expect(fifty.response.body.items).toHaveLength(50);
  });

  it('counts per request when two measured requests run concurrently', async () => {
    // The whole reason the counter is keyed by a request header rather than a
    // module-level number: parallel test files (and parallel requests) must not
    // see each other's queries. A shared counter would report 7 and 7 here.
    const [appointments, notifications] = await Promise.all([
      measureQueries(app, (a) =>
        a.get('/appointments/mine').set('Authorization', `Bearer ${manyPatientToken}`),
      ),
      measureQueries(app, (a) =>
        a.get('/notifications?limit=50').set('Authorization', `Bearer ${smallPatientToken}`),
      ),
    ]);
    expect(appointments.queries).toBe(5);
    expect(notifications.queries).toBe(2);
  });

  it('keeps GET /doctors constant from 1 to 50 results', async () => {
    const { one, fifty } = await expectConstantBudget(
      3,
      (a) => a.get('/doctors?limit=1'),
      (a) => a.get('/doctors?limit=50'),
    );
    expect(one.response.body.items).toHaveLength(1);
    expect(fifty.response.body.items).toHaveLength(50);
  });

  it('keeps GET /pharmacy-orders/facility/queue constant from 1 to 50 records', async () => {
    const { one, fifty } = await expectConstantBudget(
      3,
      (a) => a.get('/pharmacy-orders/facility/queue').set('Authorization', `Bearer ${smallFacilityToken}`),
      (a) => a.get('/pharmacy-orders/facility/queue').set('Authorization', `Bearer ${manyFacilityToken}`),
    );
    expect(one.response.body.records).toHaveLength(1);
    expect(fifty.response.body.records).toHaveLength(50);
  });
});
