// Integration coverage for the two halves of the doctor's daily workflow
// (issue #358): `GET /appointments/doctor/today` — which had no test at all —
// and `PATCH /appointments/:appointmentId/status`, previously only exercised
// as a side effect of the referral-cascade tests.
//
// The clock is pinned for the whole file (pinned in `beforeAll`, re-pinned in
// `beforeEach`), so every "today", "already started" and "not started yet"
// assertion below means the same thing at 03:00 and at 23:00 UTC. The day-view
// contract is defined by `getCalendarDayBounds(doctor.timeZone)`, which reads
// `new Date()` through the request path, so pinning `Date` is the only way to
// test the midnight-boundary behaviour without being one minute from a rollover.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { appointmentFactory, availabilitySlotFactory } from '../factories/index.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Distinct from every other integration file's port (see the port-lock helper);
// 5433 is booking.test.mts's.
const PORT = Number(process.env.TEST_POSTGRES_PORT ?? 5491);
const runId = Date.now();

/** Tuesday, 17 March 2026, 12:00 UTC — mid-day, so a slot can be placed
 * unambiguously before or after it without touching a day boundary. */
const NOON = new Date('2026-03-17T12:00:00.000Z');
/** `Asia/Kolkata` is UTC+5:30, so at `IST_NOW` the local calendar day (the
 * 18th) differs from the UTC one (the 17th) — which is what the time-zone
 * test needs. */
const IST = 'Asia/Kolkata';
const IST_NOW = new Date('2026-03-17T20:00:00.000Z');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-dayview-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
  initdbFlags: ['--encoding=UTF8'],
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
process.env.DATABASE_URL = databaseUrl;

const emailedTokens = new Map<string, string>();

type Doctor = Awaited<ReturnType<typeof import('./helpers/fixtures.mjs').makeDoctor>>;
type Patient = Awaited<ReturnType<typeof import('./helpers/fixtures.mjs').makePatient>>;

describe('doctor day view and appointment status transitions (issue #358)', () => {
  let app: any;
  let prisma: any;
  let fixtures: any;
  let patientOne: Patient;
  let patientTwo: Patient;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');

    execFileSync(
      process.execPath,
      [path.join(BACKEND_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      { cwd: BACKEND_ROOT, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' },
    );

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    fixtures = await import('./helpers/fixtures.mjs');

    app = appModule.createApp();
    prisma = dbModule.prisma;
    await fixtures.installEmailCapture(emailedTokens);

    // Pin only once the cluster and the app exist: `embedded-postgres` and the
    // pg driver measure their own connection waits with `Date.now()`, and a
    // frozen clock would turn their deadlines into either an immediate timeout
    // or an infinite wait.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOON);

    patientOne = await fixtures.makePatient(app, emailedTokens, runId);
    patientTwo = await fixtures.makePatient(app, emailedTokens, runId);
  }, 180_000);

  afterAll(async () => {
    vi.useRealTimers();
    await fixtures.resetEmailSenderFixture();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // A test that moves the clock (the time-zone one does) must not leak its
  // moment into the next test.
  beforeEach(() => {
    vi.setSystemTime(NOON);
  });

  async function makeDoctor(): Promise<Doctor> {
    return fixtures.makeDoctor(app, prisma, emailedTokens, runId);
  }

  /** Slots are inserted rather than generated: the generation API derives
   * its own dates from the wall clock, and this file needs exact instants. */
  async function makeSlot(doctor: Doctor, iso: string) {
    const startTime = new Date(iso);
    return prisma.availabilitySlot.create({
      data: availabilitySlotFactory(doctor.profileId, {
        startTime,
        endTime: new Date(startTime.getTime() + 30 * 60_000),
      }),
    });
  }

  let tempBookingSeq = 0;
  async function book(patient: Patient, slotId: string) {
    const slot = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slotId } });
    const isPast = slot.startTime <= new Date();
    if (isPast) {
      tempBookingSeq += 1;
      const tempFuture = new Date(Date.now() + (30 * 24 + tempBookingSeq) * 3600 * 1000);
      await prisma.availabilitySlot.update({
        where: { id: slotId },
        data: {
          startTime: tempFuture,
          endTime: new Date(tempFuture.getTime() + 30 * 60_000),
        },
      });
    }

    const res = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ availabilitySlotId: slotId });
    expect(res.status, `booking failed: ${res.text}`).toBe(201);

    if (isPast) {
      await prisma.availabilitySlot.update({
        where: { id: slotId },
        data: {
          startTime: slot.startTime,
          endTime: slot.endTime,
        },
      });
    }

    return res.body.id as string;
  }

  function asDoctor(doctor: Doctor) {
    return request(app).get('/appointments/doctor/today').set('Authorization', `Bearer ${doctor.accessToken}`);
  }

  function patch(doctor: Doctor, appointmentId: string, status: unknown) {
    return request(app)
      .patch(`/appointments/${appointmentId}/status`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({ status });
  }

  describe('GET /appointments/doctor/today', () => {
    it('lists the doctor’s own appointments ordered by slot start time', async () => {
      const doctor = await makeDoctor();
      const other = await makeDoctor();

      // Booked newest-first, so an ascending result can only come from the
      // ordering contract (`availabilitySlot.startTime asc, id asc`).
      const lateId = await book(patientOne, (await makeSlot(doctor, '2026-03-17T16:00:00.000Z')).id);
      const earlyId = await book(patientTwo, (await makeSlot(doctor, '2026-03-17T14:00:00.000Z')).id);
      const middleId = await book(patientOne, (await makeSlot(doctor, '2026-03-17T15:00:00.000Z')).id);
      const otherId = await book(patientTwo, (await makeSlot(other, '2026-03-17T14:30:00.000Z')).id);

      const res = await asDoctor(doctor);
      expect(res.status).toBe(200);
      expect(res.body.map((a: any) => a.id)).toEqual([earlyId, middleId, lateId]);
      expect(res.body.map((a: any) => a.id)).not.toContain(otherId);

      const asOther = await asDoctor(other);
      expect(asOther.body.map((a: any) => a.id)).toEqual([otherId]);
    });

    it('returns the slot times and no clinical detail', async () => {
      const doctor = await makeDoctor();
      const slot = await makeSlot(doctor, '2026-03-17T14:00:00.000Z');
      const appointmentId = await book(patientOne, slot.id);

      const res = await asDoctor(doctor);
      expect(res.status).toBe(200);
      const item = res.body.find((a: any) => a.id === appointmentId);
      expect(item.patientProfileId).toBe(patientOne.profileId);
      expect(item.status).toBe('scheduled');
      expect(item.availabilitySlot.id).toBe(slot.id);
      expect(item.availabilitySlot.startTime).toBe('2026-03-17T14:00:00.000Z');
      expect(item.availabilitySlot.endTime).toBe('2026-03-17T14:30:00.000Z');
      // Today's list is a calendar view: identifiers only (ARCHITECTURE.md §4).
      expect(item).not.toHaveProperty('intake');
      expect(item).not.toHaveProperty('notes');
      expect(item).not.toHaveProperty('patient');
    });

    it('excludes appointments whose slot is on another day', async () => {
      const doctor = await makeDoctor();
      const todayId = await book(patientOne, (await makeSlot(doctor, '2026-03-17T14:00:00.000Z')).id);
      const yesterdayId = await book(patientOne, (await makeSlot(doctor, '2026-03-16T14:00:00.000Z')).id);
      const tomorrowId = await book(patientTwo, (await makeSlot(doctor, '2026-03-18T14:00:00.000Z')).id);

      const today = await asDoctor(doctor);
      const ids = today.body.map((a: any) => a.id);
      expect(ids).toEqual([todayId]);
      expect(ids).not.toContain(yesterdayId);
      expect(ids).not.toContain(tomorrowId);

      // Both are still real appointments — they are out of the day window, not
      // missing. `GET /appointments/doctor` takes the same window argument.
      const all = await request(app)
        .get('/appointments/doctor')
        .query({ from: '2026-03-16', to: '2026-03-18' })
        .set('Authorization', `Bearer ${doctor.accessToken}`);
      expect(all.status).toBe(200);
      expect(all.body.map((a: any) => a.id)).toEqual(expect.arrayContaining([yesterdayId, tomorrowId]));
    });

    it('excludes a scheduled appointment that holds no slot', async () => {
      const doctor = await makeDoctor();
      const orphan = await prisma.appointment.create({
        data: appointmentFactory(patientOne.profileId, doctor.profileId, null),
      });
      const bookedId = await book(patientOne, (await makeSlot(doctor, '2026-03-17T15:00:00.000Z')).id);

      const ids = (await asDoctor(doctor)).body.map((a: any) => a.id);
      expect(ids).toEqual([bookedId]);
      expect(ids).not.toContain(orphan.id);
    });

    it('excludes an appointment as soon as it leaves `scheduled`', async () => {
      const doctor = await makeDoctor();
      // Past slots: the terminal transitions below require the slot to have
      // started, and `beforeEach` re-pins the clock at 12:00 UTC.
      const completedId = await book(patientOne, (await makeSlot(doctor, '2026-03-17T09:00:00.000Z')).id);
      const cancelledId = await book(patientTwo, (await makeSlot(doctor, '2026-03-17T13:00:00.000Z')).id);
      const noShowId = await book(patientOne, (await makeSlot(doctor, '2026-03-17T10:00:00.000Z')).id);

      expect((await patch(doctor, completedId, 'completed')).status).toBe(200);
      expect((await patch(doctor, cancelledId, 'cancelled')).status).toBe(200);
      expect((await patch(doctor, noShowId, 'no_show')).status).toBe(200);

      const ids = (await asDoctor(doctor)).body.map((a: any) => a.id);
      expect(ids).toEqual([]);
    });

    it('uses the doctor’s own time zone for the day, not UTC', async () => {
      // Kolkata is UTC+5:30 year-round, so at 20:00 UTC on the 17th the local
      // day is already the 18th: local bounds are 17 Mar 18:30Z → 18 Mar
      // 18:30Z. A slot on the UTC 17th can be yesterday locally, and a slot on
      // the UTC 18th can still be today. This is the near-midnight case the
      // issue warns about, made constant.
      //
      // The actors are created after the clock moves because access tokens
      // live 15 minutes of the same clock the verifier reads.
      vi.setSystemTime(IST_NOW);
      const doctor = await makeDoctor();
      const patient = await fixtures.makePatient(app, emailedTokens, runId);
      await prisma.doctorProfile.update({ where: { id: doctor.profileId }, data: { timeZone: IST } });

      const localToday = await book(patient, (await makeSlot(doctor, '2026-03-17T19:00:00.000Z')).id);
      const localTodayUtcTomorrow = await book(patient, (await makeSlot(doctor, '2026-03-18T01:00:00.000Z')).id);
      const localYesterday = await book(patient, (await makeSlot(doctor, '2026-03-17T18:00:00.000Z')).id);

      const ids = (await asDoctor(doctor)).body.map((a: any) => a.id);
      expect(ids).toEqual([localToday, localTodayUtcTomorrow]);
      expect(ids).not.toContain(localYesterday);
    });

    it('is doctor-only', async () => {
      const doctor = await makeDoctor();
      const anonymous = await request(app).get('/appointments/doctor/today');
      expect(anonymous.status).toBe(401);

      const asPatient = await request(app)
        .get('/appointments/doctor/today')
        .set('Authorization', `Bearer ${patientOne.accessToken}`);
      expect(asPatient.status).toBe(403);
      expect(asPatient.body.message).toBe('You do not have permission to perform this action.');

      const admin = await fixtures.makeAdmin(app, prisma, emailedTokens, runId);
      const asAdmin = await request(app)
        .get('/appointments/doctor/today')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(asAdmin.status).toBe(403);

      // A doctor with no appointments gets an empty list, not a 404.
      expect((await asDoctor(doctor)).body).toEqual([]);
    });
  });

  describe('PATCH /appointments/:appointmentId/status', () => {
    it('allows each legal transition out of `scheduled`', async () => {
      const doctor = await makeDoctor();
      const cases = [
        ['completed', '2026-03-17T11:00:00.000Z'],
        ['cancelled', '2026-03-17T14:00:00.000Z'],
        ['no_show', '2026-03-17T10:00:00.000Z'],
      ] as const;

      for (const [status, iso] of cases) {
        const appointmentId = await book(patientOne, (await makeSlot(doctor, iso)).id);
        const res = await patch(doctor, appointmentId, status);
        expect(res.status, `${status}: ${res.text}`).toBe(200);
        expect(res.body.id).toBe(appointmentId);
        expect(res.body.status).toBe(status);

        const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
        expect(row.status).toBe(status);
      }
    });

    it('re-opens a future slot on cancellation so another patient can book it', async () => {
      const doctor = await makeDoctor();
      const slot = await makeSlot(doctor, '2026-03-17T14:00:00.000Z');
      const appointmentId = await book(patientOne, slot.id);

      expect((await patch(doctor, appointmentId, 'cancelled')).status).toBe(200);

      const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
      expect(row.availabilitySlotId).toBeNull();
      const freed = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(freed.status).toBe('open');

      // The unique slot claim has to be gone, or re-booking would collide.
      const rebookedId = await book(patientTwo, slot.id);
      expect(rebookedId).not.toBe(appointmentId);
      expect((await prisma.appointment.findUniqueOrThrow({ where: { id: rebookedId } })).availabilitySlotId).toBe(
        slot.id,
      );
    });

    it('leaves a slot that has already started booked when cancelling', async () => {
      const doctor = await makeDoctor();
      const slot = await makeSlot(doctor, '2026-03-17T11:00:00.000Z');
      const appointmentId = await book(patientOne, slot.id);

      expect((await patch(doctor, appointmentId, 'cancelled')).status).toBe(200);

      const freed = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(freed.status).toBe('booked');
      const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
      expect(row.availabilitySlotId).toBe(slot.id);
    });

    it('refuses to record completion or a no-show before the slot starts', async () => {
      const doctor = await makeDoctor();
      const appointmentId = await book(patientOne, (await makeSlot(doctor, '2026-03-17T14:00:00.000Z')).id);

      for (const status of ['completed', 'no_show']) {
        const res = await patch(doctor, appointmentId, status);
        expect(res.status, status).toBe(409);
        expect(res.body.code).toBe('APPOINTMENT_NOT_STARTED');
      }
      const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
      expect(row.status).toBe('scheduled');
    });

    it('refuses completion and no-show once the slot has been released', async () => {
      const doctor = await makeDoctor();
      // A `scheduled` appointment with no slot is reachable: cancelling clears
      // the link, and a reschedule in flight can leave the same shape.
      const appointmentId = (
        await prisma.appointment.create({
          data: appointmentFactory(patientOne.profileId, doctor.profileId, null),
        })
      ).id;

      for (const status of ['completed', 'no_show']) {
        const res = await patch(doctor, appointmentId, status);
        expect(res.status, status).toBe(409);
        expect(res.body.code).toBe('APPOINTMENT_NOT_STARTED');
        expect(res.body.message).toBe(
          'Appointments with a released slot cannot be marked completed or no-show.',
        );
      }
    });

    it('refuses every transition out of a terminal status', async () => {
      const doctor = await makeDoctor();
      const terminal = ['completed', 'cancelled', 'late_cancelled', 'no_show'] as const;

      for (const from of terminal) {
        // Inserted directly: `late_cancelled` is not reachable through this
        // endpoint at all (see the 400 case below), and going through the
        // legal transition first would only test the same conditional UPDATE.
        const appointmentId = (
          await prisma.appointment.create({
            data: appointmentFactory(patientOne.profileId, doctor.profileId, null, { status: from }),
          })
        ).id;

        for (const to of ['completed', 'cancelled', 'no_show']) {
          const res = await patch(doctor, appointmentId, to);
          expect(res.status, `${from} -> ${to}`).toBe(409);
          expect(res.body.message).toBe('Only a scheduled appointment can change status.');
        }
        const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
        expect(row.status).toBe(from);
      }
    });

    it('rejects a status this endpoint is not allowed to assign', async () => {
      const doctor = await makeDoctor();
      const appointmentId = await book(patientOne, (await makeSlot(doctor, '2026-03-17T14:00:00.000Z')).id);

      // `late_cancelled` is legal in the state machine but patient-caused, so
      // the doctor-facing schema does not accept it.
      const late = await patch(doctor, appointmentId, 'late_cancelled');
      expect(late.status).toBe(400);
      const rewind = await patch(doctor, appointmentId, 'scheduled');
      expect(rewind.status).toBe(400);
      const missing = await request(app)
        .patch(`/appointments/${appointmentId}/status`)
        .set('Authorization', `Bearer ${doctor.accessToken}`)
        .send({});
      expect(missing.status).toBe(400);

      const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
      expect(row.status).toBe('scheduled');
    });

    it('404s an unknown appointment before revealing anything about it', async () => {
      const doctor = await makeDoctor();
      const res = await patch(doctor, '00000000-0000-4000-8000-000000000000', 'completed');
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Appointment not found.');
    });

    it('forbids another doctor from transitioning the appointment', async () => {
      const doctor = await makeDoctor();
      const interloper = await makeDoctor();
      const appointmentId = await book(patientOne, (await makeSlot(doctor, '2026-03-17T11:00:00.000Z')).id);

      const res = await patch(interloper, appointmentId, 'completed');
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('You can only manage your own doctor profile.');

      const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
      expect(row.status).toBe('scheduled');
      expect((await asDoctor(doctor)).body.map((a: any) => a.id)).toEqual([appointmentId]);
    });

    it('is doctor-only', async () => {
      const doctor = await makeDoctor();
      const appointmentId = await book(patientOne, (await makeSlot(doctor, '2026-03-17T11:00:00.000Z')).id);

      const anonymous = await request(app).patch(`/appointments/${appointmentId}/status`).send({ status: 'completed' });
      expect(anonymous.status).toBe(401);

      const asPatient = await request(app)
        .patch(`/appointments/${appointmentId}/status`)
        .set('Authorization', `Bearer ${patientOne.accessToken}`)
        .send({ status: 'completed' });
      expect(asPatient.status).toBe(403);

      const admin = await fixtures.makeAdmin(app, prisma, emailedTokens, runId);
      const asAdmin = await request(app)
        .patch(`/appointments/${appointmentId}/status`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ status: 'completed' });
      expect(asAdmin.status).toBe(403);

      const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
      expect(row.status).toBe('scheduled');
    });

    it('needs no If-Match: its guard is the conditional UPDATE itself', async () => {
      const doctor = await makeDoctor();
      const appointmentId = await book(patientOne, (await makeSlot(doctor, '2026-03-17T11:00:00.000Z')).id);
      const read = await request(app)
        .get(`/appointments/${appointmentId}`)
        .set('Authorization', `Bearer ${patientOne.accessToken}`);
      expect(read.headers.etag).toBeTruthy();

      // ARCHITECTURE_ESSENTIALS.md hard rule 7: a transition that is already
      // conditional keeps its own guard, so a stale-free request without the
      // precondition header succeeds rather than returning 428.
      const res = await patch(doctor, appointmentId, 'completed');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
    });

    it('lets exactly one of several concurrent transitions win', async () => {
      const doctor = await makeDoctor();
      const appointmentId = await book(patientOne, (await makeSlot(doctor, '2026-03-17T11:00:00.000Z')).id);

      const responses = await Promise.all([
        patch(doctor, appointmentId, 'completed'),
        patch(doctor, appointmentId, 'no_show'),
        patch(doctor, appointmentId, 'cancelled'),
      ]);
      const winners = responses.filter((res) => res.status === 200);
      const losers = responses.filter((res) => res.status === 409);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(2);

      // Two guards can each stop a loser: the state-machine check on the row it
      // read, and the conditional UPDATE if it read `scheduled` before the
      // winner committed. Either way the refusal is stated, not a 500.
      const refused = [
        'Only a scheduled appointment can change status.',
        'This appointment is no longer scheduled.',
      ];
      for (const loser of losers) expect(refused).toContain(loser.body.message);

      // One write, and it is the winner's: a losing request must not have
      // overwritten the status that the winning one stored.
      const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
      expect(row.status).toBe(winners[0].body.status);

      const ids = (await asDoctor(doctor)).body.map((a: any) => a.id);
      expect(ids).toEqual([]);
    });

    it('lets exactly one of several concurrent cancellations win, and frees the slot once', async () => {
      const doctor = await makeDoctor();
      const slot = await makeSlot(doctor, '2026-03-17T14:00:00.000Z');
      const appointmentId = await book(patientOne, slot.id);

      const responses = await Promise.all([
        patch(doctor, appointmentId, 'cancelled'),
        patch(doctor, appointmentId, 'cancelled'),
        patch(doctor, appointmentId, 'cancelled'),
      ]);
      expect(responses.filter((res) => res.status === 200)).toHaveLength(1);
      expect(responses.filter((res) => res.status === 409)).toHaveLength(2);

      // A double release would have re-opened a slot the winner already freed;
      // one winner means the slot is booked by exactly the re-booking patient.
      const freed = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(freed.status).toBe('open');
      const rebookedId = await book(patientTwo, slot.id);
      expect((await prisma.appointment.findUniqueOrThrow({ where: { id: rebookedId } })).status).toBe('scheduled');
    });
  });
});
