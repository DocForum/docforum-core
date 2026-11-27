// Doctor cancels a whole day (issue #338) and one AuditEvent per appointment
// status transition (issue #337). Port 5491.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import {
  bookAppointment,
  generateSlots,
  installEmailCapture,
  makeDoctor,
  makePatient,
  resetEmailSenderFixture,
  setAppointmentStatus,
  shiftSlotToPast,
  type DoctorFixture,
  type PatientFixture,
} from './helpers/fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5491;
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

const tomorrow = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe('doctor cancel-day and appointment transition audit', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let appointmentsService: typeof import('../../src/modules/appointments/services/index.js');
  const emailedTokens = new Map<string, string>();
  let patient: PatientFixture;

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
    appointmentsService = await import('../../src/modules/appointments/services/index.js');
    await installEmailCapture(emailedTokens);
    patient = await makePatient(app, emailedTokens, runId);
  });

  afterAll(async () => {
    await resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function utcDoctor(): Promise<DoctorFixture> {
    const doctor = await makeDoctor(app, prisma, emailedTokens, runId);
    await prisma.doctorProfile.update({ where: { id: doctor.profileId }, data: { timeZone: 'UTC' } });
    return doctor;
  }

  function cancelDay(doctor: { accessToken: string }, body: unknown) {
    return request(app)
      .post('/appointments/doctor/cancel-day')
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send(body as object);
  }

  async function slotsOn(doctorProfileId: string, date: string) {
    return prisma.availabilitySlot.findMany({
      where: {
        doctorProfileId,
        startTime: { gte: new Date(`${date}T00:00:00Z`), lt: new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000) },
      },
    });
  }

  it('cancels every scheduled appointment of the day, releases and closes its slots, and leaves other doctors alone', async () => {
    const doctor = await utcDoctor();
    const other = await utcDoctor();
    const slots = await generateSlots(app, doctor);
    const otherSlots = await generateSlots(app, other);
    const a1 = await bookAppointment(app, patient, slots[0]);
    const a2 = await bookAppointment(app, patient, slots[3]);
    const untouched = await bookAppointment(app, patient, otherSlots[0]);

    const slotsBefore = (await slotsOn(doctor.profileId, tomorrow())).length;
    const res = await cancelDay(doctor, { date: tomorrow(), reason: 'illness' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ date: tomorrow(), cancelled: 2, failures: [] });
    expect(res.body.appointmentIds.sort()).toEqual([a1.id, a2.id].sort());
    expect(res.body.slotsClosed).toBe(slotsBefore);

    for (const id of [a1.id, a2.id]) {
      const appt = await prisma.appointment.findUniqueOrThrow({ where: { id } });
      expect(appt.status).toBe('cancelled');
      expect(appt.availabilitySlotId).toBeNull();
      const events = await prisma.auditEvent.findMany({ where: { entityType: 'Appointment', entityId: id, action: 'appointment.cancelled' } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorUserId: doctor.userId, fromState: 'scheduled', toState: 'cancelled' });
      expect(events[0].metadata).toMatchObject({ reason: 'doctor_cancel_day', cancelReason: 'illness', slotReleased: true });
    }
    // Released slots were closed with the rest: nothing bookable is left.
    expect(await slotsOn(doctor.profileId, tomorrow())).toHaveLength(0);
    const book = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ availabilitySlotId: slots[1] });
    expect(book.status).not.toBe(201);

    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: untouched.id } })).status).toBe('scheduled');
    expect((await slotsOn(other.profileId, tomorrow())).length).toBeGreaterThanOrEqual(otherSlots.length);

    // Running it again is a harmless no-op.
    const again = await cancelDay(doctor, { date: tomorrow() });
    expect(again.body).toMatchObject({ cancelled: 0, slotsClosed: 0, failures: [] });
  });

  it('leaves appointments and slots that already started earlier in the day untouched', async () => {
    const doctor = await utcDoctor();
    const slots = await generateSlots(app, doctor);
    const startTimes = await prisma.availabilitySlot.findMany({ where: { id: { in: slots } }, orderBy: { startTime: 'asc' } });
    const early = await bookAppointment(app, patient, startTimes[0].id); // 08:00
    const late = await bookAppointment(app, patient, startTimes[startTimes.length - 1].id); // 19:30
    const doctorUser = await prisma.user.findUniqueOrThrow({ where: { id: doctor.userId } });
    // "Now" is midday on that day: 08:00 has happened, 19:30 has not.
    const now = new Date(`${tomorrow()}T12:00:00Z`);
    const result = await appointmentsService.cancelDay(
      { userId: doctor.userId, role: doctorUser.role, requestId: 'test' },
      tomorrow(),
      undefined,
      now,
    );
    expect(result.appointmentIds).toEqual([late.id]);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: early.id } })).status).toBe('scheduled');
    const remaining = await slotsOn(doctor.profileId, tomorrow());
    // Only the slots before noon survive (08:00-11:30 = 8 slots).
    expect(remaining.every((slot) => slot.startTime < now)).toBe(true);
    expect(remaining).toHaveLength(8);
  });

  it('never leaves a booking that raced the cancel standing', async () => {
    const doctor = await utcDoctor();
    const slots = await generateSlots(app, doctor);
    const racers = await Promise.all(Array.from({ length: 4 }, () => makePatient(app, emailedTokens, runId)));
    const [cancel, ...bookings] = await Promise.all([
      cancelDay(doctor, { date: tomorrow() }),
      ...racers.map((p, i) =>
        request(app).post('/appointments').set('Authorization', `Bearer ${p.accessToken}`).send({ availabilitySlotId: slots[i] }),
      ),
    ]);
    expect(cancel.status).toBe(200);
    for (const b of bookings) expect([201, 400, 404, 409]).toContain(b.status);
    const stillScheduled = await prisma.appointment.count({
      where: { doctorProfileId: doctor.profileId, status: 'scheduled' },
    });
    expect(stillScheduled).toBe(0);
    expect(await slotsOn(doctor.profileId, tomorrow())).toHaveLength(0);
  });

  it('validates the date and only lets doctors call it', async () => {
    const doctor = await utcDoctor();
    for (const date of ['not-a-date', '2026-13-01', '2026-02-30', '', undefined]) {
      const res = await cancelDay(doctor, { date });
      expect(res.status).toBe(400);
    }
    // reason is a code (it lands in the audit trail), never free text.
    expect((await cancelDay(doctor, { date: tomorrow(), reason: 'I have the flu' })).status).toBe(400);
    const asPatient = await request(app)
      .post('/appointments/doctor/cancel-day')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ date: tomorrow() });
    expect(asPatient.status).toBe(403);
    expect((await request(app).post('/appointments/doctor/cancel-day').send({ date: tomorrow() })).status).toBe(401);
  });

  it('writes exactly one audit event per doctor and patient transition (issue #337)', async () => {
    const doctor = await utcDoctor();
    const slots = await generateSlots(app, doctor);

    const completed = await bookAppointment(app, patient, slots[0]);
    await shiftSlotToPast(prisma, slots[0]);
    expect((await setAppointmentStatus(app, doctor, completed.id, 'completed')).status).toBe(200);

    const patientCancelled = await bookAppointment(app, patient, slots[1]);
    const cancel = await request(app)
      .patch(`/appointments/${patientCancelled.id}/cancel`)
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(cancel.status).toBe(200);

    const doctorCancelled = await bookAppointment(app, patient, slots[2]);
    expect((await setAppointmentStatus(app, doctor, doctorCancelled.id, 'cancelled')).status).toBe(200);

    const onlyEventFor = async (id: string) => {
      const events = await prisma.auditEvent.findMany({
        where: { entityType: 'Appointment', entityId: id, NOT: { action: 'appointment.booked' } },
      });
      expect(events).toHaveLength(1);
      return events[0];
    };

    const c = await onlyEventFor(completed.id);
    expect(c).toMatchObject({ action: 'appointment.status_changed', actorUserId: doctor.userId, fromState: 'scheduled', toState: 'completed' });
    expect(c.metadata).toMatchObject({ reason: 'doctor', slotReleased: false });

    const p = await onlyEventFor(patientCancelled.id);
    expect(p).toMatchObject({ action: 'appointment.cancelled', actorUserId: patient.userId, fromState: 'scheduled' });
    expect(p.metadata).toMatchObject({ reason: 'patient', patientProfileId: patient.profileId, slotId: slots[1] });

    const d = await onlyEventFor(doctorCancelled.id);
    expect(d).toMatchObject({ action: 'appointment.cancelled', actorUserId: doctor.userId, toState: 'cancelled' });
    expect(d.metadata).toMatchObject({ reason: 'doctor', slotReleased: true });
  });
});
