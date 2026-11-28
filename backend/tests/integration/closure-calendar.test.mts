// Closure calendar (Phase 2, issue #131). Port 5503.
//
// Proves the properties the issue is reviewed on:
//   - creating a platform closure removes the still-open slots in range with
//     conditional writes and REPORTS booked appointments without cancelling;
//   - slot generation skips a closed day and works again once it is deleted;
//   - a closure created while bookings are in flight never cancels one and
//     leaves no bookable slot on the closed day;
//   - all-day closures are read in their own time zone;
//   - admin CRUD is guarded (roles, validation, If-Match) and audited.
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
  makeAdmin,
  makeDoctor,
  makePatient,
  resetEmailSenderFixture,
  type DoctorFixture,
  type PatientFixture,
} from './helpers/fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5503;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-closure-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
  // The migration that inserts an arrow character fails under a WIN1252
  // cluster (see query-budgets.test.mts).
  initdbFlags: ['--encoding=UTF8'],
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_closure_test`;

const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const tomorrow = () => isoDay(1);

describe('platform and clinic closure calendar', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  const emailedTokens = new Map<string, string>();
  let admin: { accessToken: string; userId: string };
  let patient: PatientFixture;
  let facilityProfileId: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_closure_test');
    // The local Prisma CLI through node, not `npx` — npx is a .cmd shim on
    // Windows and the bare name is not executable there.
    execFileSync(process.execPath, [path.join(BACKEND_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;
    app = (await import('../../src/app.js')).createApp();
    prisma = (await import('../../src/db/prisma-client.js')).prisma;
    await installEmailCapture(emailedTokens);
    admin = await makeAdmin(app, prisma, emailedTokens, runId);
    patient = await makePatient(app, emailedTokens, runId);

    const facilityUser = await prisma.user.create({
      data: {
        email: `closure-facility-${runId}@example.com`,
        passwordHash: 'unused-in-test',
        role: 'facility',
        emailVerifiedAt: new Date(),
      },
    });
    const facility = await prisma.facilityProfile.create({
      data: { userId: facilityUser.id, name: 'Closure Test Clinic', type: 'pharmacy' },
    });
    facilityProfileId = facility.id;
  }, 240_000);

  afterAll(async () => {
    await resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function doctorIn(timeZone: string): Promise<DoctorFixture> {
    const doctor = await makeDoctor(app, prisma, emailedTokens, runId);
    await prisma.doctorProfile.update({ where: { id: doctor.profileId }, data: { timeZone } });
    return doctor;
  }

  function createClosure(body: unknown, token?: string) {
    const req = request(app).post('/availability/admin/closures');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(body as object);
  }

  /** Generate the standard 08:00–20:00 window on one specific calendar day
   * (the shared fixture only ever generates `tomorrow`). */
  async function generateSlotsOn(doctor: DoctorFixture, date: string): Promise<string[]> {
    const res = await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({ date, startHour: 8, endHour: 20, slotLengthMinutes: 30 });
    expect(res.status).toBe(201);
    const dayStart = new Date(`${date}T00:00:00Z`);
    const rows = await prisma.availabilitySlot.findMany({
      where: {
        doctorProfileId: doctor.profileId,
        startTime: { gte: dayStart, lt: new Date(dayStart.getTime() + 86_400_000) },
      },
    });
    return rows.map((row) => row.id);
  }

  async function slotCountsFor(doctorProfileId: string) {
    const slots = await prisma.availabilitySlot.findMany({ where: { doctorProfileId } });
    return {
      total: slots.length,
      open: slots.filter((slot) => slot.status === 'open').length,
      booked: slots.filter((slot) => slot.status === 'booked').length,
    };
  }

  it('removes the open slots in range, reports booked appointments, and cancels nothing', async () => {
    const doctor = await doctorIn('UTC');
    const day = tomorrow();
    const slots = await generateSlots(app, doctor);
    const first = await bookAppointment(app, patient, slots[0]!);
    const second = await bookAppointment(app, patient, slots[3]!);
    expect(await slotCountsFor(doctor.profileId)).toEqual({ total: 24, open: 22, booked: 2 });

    const res = await createClosure(
      { scope: 'platform', startDate: day, endDate: day, timeZone: 'UTC', reason: 'Public holiday' },
      admin.accessToken,
    );
    expect(res.status).toBe(201);
    expect(res.body.closure).toMatchObject({
      scope: 'platform',
      facilityProfileId: null,
      startDate: day,
      endDate: day,
      timeZone: 'UTC',
      reason: 'Public holiday',
      version: 1,
    });
    // 22 open slots removed by one conditional DELETE; the 2 booked ones stay.
    expect(res.body.openSlotsRemoved).toBe(22);
    expect(res.body.affectedBookingCount).toBe(2);
    expect(res.body.affectedBookings.map((b: { appointmentId: string }) => b.appointmentId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(await slotCountsFor(doctor.profileId)).toEqual({ total: 2, open: 0, booked: 2 });

    // Reported, never cancelled: both appointments are still scheduled and
    // still hold their slot.
    for (const id of [first.id, second.id]) {
      const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id } });
      expect(appointment.status).toBe('scheduled');
      expect(appointment.availabilitySlotId).not.toBeNull();
    }

    // Nothing is bookable on the closed day, and generating it again adds
    // nothing (skippedClosed counts the slots the closure suppresses).
    const listed = await request(app).get(`/availability/doctors/${doctor.profileId}/slots`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(0);
    const regenerate = await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({ date: day, startHour: 8, endHour: 20, slotLengthMinutes: 30 });
    expect(regenerate.status).toBe(201);
    expect(regenerate.body).toMatchObject({ created: 0, skippedClosed: 24 });

    // Every write is audited inside its own transaction.
    const events = await prisma.auditEvent.findMany({
      where: { entityType: 'ClosurePeriod', entityId: res.body.closure.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'closure.created',
      actorUserId: admin.userId,
      actorRole: 'admin',
      toState: 'platform',
    });
    expect(events[0]!.metadata).toMatchObject({ scope: 'platform', startDate: day, endDate: day });
  });

  it('lists closures for clients and admins, and deleting one unblocks generation', async () => {
    const doctor = await doctorIn('UTC');
    const day = isoDay(2);
    const created = await createClosure(
      { scope: 'platform', startDate: day, endDate: day, reason: 'Building maintenance' },
      admin.accessToken,
    );
    expect(created.status).toBe(201);
    // timeZone defaults to UTC.
    expect(created.body.closure.timeZone).toBe('UTC');

    const publicList = await request(app).get('/availability/closures');
    expect(publicList.status).toBe(200);
    expect(publicList.body.closures.map((c: { id: string }) => c.id)).toContain(created.body.closure.id);

    const adminList = await request(app)
      .get(`/availability/admin/closures?from=${day}&to=${day}`)
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(adminList.status).toBe(200);
    expect(adminList.body.closures).toHaveLength(1);

    // Generation on the closed day creates nothing; after DELETE it works.
    const blocked = await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({ date: day, startHour: 8, endHour: 20, slotLengthMinutes: 30 });
    expect(blocked.body).toMatchObject({ created: 0, skippedClosed: 24 });

    const removed = await request(app)
      .delete(`/availability/admin/closures/${created.body.closure.id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(removed.status).toBe(204);
    expect(
      (await request(app).get('/availability/admin/closures').set('Authorization', `Bearer ${admin.accessToken}`)).body
        .closures.map((c: { id: string }) => c.id),
    ).not.toContain(created.body.closure.id);

    const reopened = await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({ date: day, startHour: 8, endHour: 20, slotLengthMinutes: 30 });
    expect(reopened.status).toBe(201);
    expect(reopened.body).toMatchObject({ created: 24, skippedClosed: 0 });
  });

  it('records clinic-scoped closures without touching a doctor’s calendar (PRD §8.6 gap)', async () => {
    const doctor = await doctorIn('UTC');
    // Its own day: a platform closure from another test must not interfere.
    const day = isoDay(5);
    expect(await generateSlotsOn(doctor, day)).toHaveLength(24);
    const before = await slotCountsFor(doctor.profileId);

    const res = await createClosure(
      { scope: 'facility', facilityProfileId, startDate: day, endDate: day, reason: 'Clinic closed' },
      admin.accessToken,
    );
    expect(res.status).toBe(201);
    expect(res.body.closure).toMatchObject({ scope: 'facility', facilityProfileId });
    // No slot is attributable to a facility in v1, so nothing is removed and
    // nothing is reported — documented, not silently ignored.
    expect(res.body.openSlotsRemoved).toBe(0);
    expect(res.body.affectedBookings).toHaveLength(0);
    expect(await slotCountsFor(doctor.profileId)).toEqual(before);

    const listed = await request(app).get('/availability/closures?scope=facility');
    expect(listed.body.closures.map((c: { id: string }) => c.id)).toContain(res.body.closure.id);

    // Scope/facility consistency is enforced, not just documented.
    expect(
      (await createClosure({ scope: 'facility', startDate: day, endDate: day, reason: 'x' }, admin.accessToken)).body.code,
    ).toBe('CLOSURE_FACILITY_REQUIRED');
    expect(
      (
        await createClosure(
          { scope: 'platform', facilityProfileId, startDate: day, endDate: day, reason: 'x' },
          admin.accessToken,
        )
      ).body.code,
    ).toBe('CLOSURE_SCOPE_CONFLICT');
    expect(
      (
        await createClosure(
          { scope: 'facility', facilityProfileId: '00000000-0000-4000-8000-000000000000', startDate: day, endDate: day, reason: 'x' },
          admin.accessToken,
        )
      ).body.code,
    ).toBe('FACILITY_NOT_FOUND');
  });

  it('reads an all-day closure in its own time zone', async () => {
    const doctor = await doctorIn('America/New_York');
    const day = isoDay(6);
    const generated = await request(app)
      .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctor.accessToken}`)
      .send({ date: day, startHour: 8, endHour: 20, slotLengthMinutes: 30 });
    expect(generated.status).toBe(201);
    expect(generated.body.created).toBe(24);

    const res = await createClosure(
      { scope: 'platform', startDate: day, endDate: day, timeZone: 'America/New_York', reason: 'Thanksgiving' },
      admin.accessToken,
    );
    expect(res.status).toBe(201);
    // Every 08:00–20:00 New York slot for that local day is inside the window.
    expect(res.body.openSlotsRemoved).toBe(24);
    expect(await slotCountsFor(doctor.profileId)).toEqual({ total: 0, open: 0, booked: 0 });
  });

  it('never cancels a booking that raced the closure, and leaves no open slot behind', async () => {
    const doctor = await doctorIn('UTC');
    const day = isoDay(7);
    const slots = await generateSlotsOn(doctor, day);
    expect(slots).toHaveLength(24);
    const racers = await Promise.all(Array.from({ length: 6 }, () => makePatient(app, emailedTokens, runId)));

    const [closure, ...bookings] = await Promise.all([
      createClosure({ scope: 'platform', startDate: day, endDate: day, reason: 'Emergency' }, admin.accessToken),
      ...racers.map((racer, index) =>
        request(app)
          .post('/appointments')
          .set('Authorization', `Bearer ${racer.accessToken}`)
          .send({ availabilitySlotId: slots[index]! }),
      ),
    ]);

    expect(closure.status).toBe(201);
    const booked = bookings.filter((res) => res.status === 201);
    for (const res of bookings) expect([201, 404, 409]).toContain(res.status);

    const counts = await slotCountsFor(doctor.profileId);
    // Whatever the interleaving, the closed day is not bookable any more...
    expect(counts.open).toBe(0);
    expect(counts.total).toBe(counts.booked);
    // ...and no booking was cancelled by the closure.
    const cancelled = await prisma.appointment.count({
      where: { doctorProfileId: doctor.profileId, status: { in: ['cancelled', 'late_cancelled'] } },
    });
    expect(cancelled).toBe(0);
    for (const res of booked) {
      const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(appointment.status).toBe('scheduled');
      expect(appointment.availabilitySlotId).not.toBeNull();
    }

    // A closure created after everything settled reports every surviving
    // booking — the report is what a human acts on, so nothing may be missing.
    const after = await createClosure(
      { scope: 'platform', startDate: day, endDate: day, reason: 'Emergency' },
      admin.accessToken,
    );
    expect(after.status).toBe(201);
    const reported = new Set(after.body.affectedBookings.map((b: { appointmentId: string }) => b.appointmentId));
    for (const res of booked) expect(reported.has(res.body.id as string)).toBe(true);
    expect(after.body.openSlotsRemoved).toBe(0);
  });

  it('guards PATCH with If-Match and re-applies the closure to the new range', async () => {
    const doctor = await doctorIn('UTC');
    const day = isoDay(3);
    const nextDay = isoDay(4);
    expect(await generateSlotsOn(doctor, day)).toHaveLength(24);
    expect(await generateSlotsOn(doctor, nextDay)).toHaveLength(24);

    const created = await createClosure(
      { scope: 'platform', startDate: day, endDate: day, reason: 'Holiday' },
      admin.accessToken,
    );
    const closureId = created.body.closure.id as string;

    const read = await request(app)
      .get(`/availability/admin/closures/${closureId}`)
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(read.status).toBe(200);
    expect(read.headers.etag).toBe('"1"');

    const patch = (ifMatch?: string, body: object = { reason: 'Holiday (extended)' }) => {
      const req = request(app)
        .patch(`/availability/admin/closures/${closureId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      if (ifMatch) req.set('If-Match', ifMatch);
      return req.send(body);
    };
    expect((await patch()).status).toBe(428);
    expect((await patch('W/"1"')).status).toBe(400);
    expect((await patch('"99"')).status).toBe(412);

    // Extend the closure over the next day: the newly covered open slots go.
    const extended = await patch(read.headers.etag, { endDate: nextDay });
    expect(extended.status).toBe(200);
    expect(extended.headers.etag).toBe('"2"');
    expect(extended.body.closure).toMatchObject({ startDate: day, endDate: nextDay, version: 2 });

    const nextDaySlots = await prisma.availabilitySlot.count({
      where: {
        doctorProfileId: doctor.profileId,
        startTime: { gte: new Date(`${nextDay}T00:00:00Z`), lt: new Date(new Date(`${nextDay}T00:00:00Z`).getTime() + 86_400_000) },
      },
    });
    expect(nextDaySlots).toBe(0);

    // The version read before the write can no longer be used.
    expect((await patch(read.headers.etag)).status).toBe(412);

    const events = await prisma.auditEvent.findMany({
      where: { entityType: 'ClosurePeriod', entityId: closureId, action: 'closure.updated' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromState: `${day}..${day}`, toState: `${day}..${nextDay}` });
  });

  it('is admin-only and validates the range', async () => {
    const day = tomorrow();
    const asPatient = await createClosure(
      { scope: 'platform', startDate: day, endDate: day, reason: 'Holiday' },
      patient.accessToken,
    );
    expect(asPatient.status).toBe(403);
    expect((await createClosure({ scope: 'platform', startDate: day, endDate: day, reason: 'x' })).status).toBe(401);
    expect(
      (await request(app).get('/availability/admin/closures').set('Authorization', `Bearer ${patient.accessToken}`))
        .status,
    ).toBe(403);

    const invalid = async (body: Record<string, unknown>) =>
      (await createClosure(body, admin.accessToken)).body.code as string;
    expect(await invalid({ scope: 'platform', startDate: 'not-a-date', endDate: day, reason: 'x' })).toBe('VALIDATION_FAILED');
    expect(await invalid({ scope: 'platform', startDate: '2026-02-30', endDate: '2026-03-01', reason: 'x' })).toBe(
      'VALIDATION_FAILED',
    );
    expect(await invalid({ scope: 'platform', startDate: day, endDate: isoDay(0), reason: 'x' })).toBe(
      'INVALID_DATE_RANGE',
    );
    expect(await invalid({ scope: 'platform', startDate: day, endDate: isoDay(400), reason: 'x' })).toBe(
      'DATE_RANGE_TOO_LARGE',
    );
    expect(await invalid({ scope: 'platform', startDate: day, endDate: day, reason: '' })).toBe('VALIDATION_FAILED');
    expect(await invalid({ scope: 'platform', startDate: day, endDate: day, reason: 'x', timeZone: 'Mars/Base' })).toBe(
      'INVALID_TIME_ZONE',
    );
    // Unknown fields are refused rather than silently dropped.
    expect(await invalid({ scope: 'platform', startDate: day, endDate: day, reason: 'x', surprise: 1 })).toBe(
      'VALIDATION_FAILED',
    );
  });
});
